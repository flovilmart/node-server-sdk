const errors = require('./errors');
const httpUtils = require('./utils/httpUtils');
const messages = require('./messages');
const { EventSource } = require('launchdarkly-eventsource');
const dataKind = require('./versioned_data_kind');

function StreamProcessor(sdkKey, config, requestor, diagnosticsManager, specifiedEventSourceFactory) {
  const processor = {},
    featureStore = config.featureStore;
  let es;
  let connectionAttemptStartTime;

  const headers = httpUtils.getDefaultHeaders(sdkKey, config);

  const eventSourceFactory = specifiedEventSourceFactory || EventSource;

  function getKeyFromPath(kind, path) {
    return path.startsWith(kind.streamApiPath) ? path.substring(kind.streamApiPath.length) : null;
  }

  function logConnectionStarted() {
    connectionAttemptStartTime = new Date().getTime();
  }

  function logConnectionResult(success) {
    if (connectionAttemptStartTime && diagnosticsManager) {
      diagnosticsManager.recordStreamInit(
        connectionAttemptStartTime,
        !success,
        new Date().getTime() - connectionAttemptStartTime
      );
    }
    connectionAttemptStartTime = null;
  }

  processor.start = fn => {
    const cb = fn || function() {};

    logConnectionStarted();

    function handleError(err) {
      // launchdarkly-eventsource expects this function to return true if it should retry, false to shut down.
      if (err.status && !errors.isHttpErrorRecoverable(err.status)) {
        const message = messages.httpErrorMessage(err.status, 'streaming request');
        config.logger.error(message);
        logConnectionResult(false);
        cb(new errors.LDStreamingError(err.message, err.status));
        return false;
      }
      const message = messages.httpErrorMessage(err.status, 'streaming request', 'will retry');
      config.logger.warn(message);
      logConnectionResult(false);
      logConnectionStarted();
      return true;
    }

    es = new eventSourceFactory(config.streamUri + '/all', {
      agent: config.proxyAgent,
      errorFilter: handleError,
      headers,
      initialRetryDelayMillis: config.streamInitialReconnectDelayMillis
        ? config.streamInitialReconnectDelayMillis
        : 1000 * config.streamInitialReconnectDelay,
      retryResetIntervalMillis: 60000,
      tlsParams: config.tlsParams,
    });

    es.onclose = () => {
      config.logger.info('Closed LaunchDarkly stream connection');
    };

    // This stub handler only exists because error events must have a listener; handleError() does the work.
    es.onerror = () => {};

    es.onopen = () => {
      config.logger.info('Opened LaunchDarkly stream connection');
    };

    es.onretrying = e => {
      config.logger.info('Will retry stream connection in ' + e.delayMillis + ' milliseconds');
    };

    function reportJsonError(type, data) {
      config.logger.error('Stream received invalid data in "' + type + '" message');
      config.logger.debug('Invalid JSON follows: ' + data);
      cb(new errors.LDStreamingError('Malformed JSON data in event stream'));
    }

    es.addEventListener('put', e => {
      config.logger.debug('Received put event');
      if (e && e.data) {
        logConnectionResult(true);
        let all;
        try {
          all = JSON.parse(e.data);
        } catch (err) {
          reportJsonError('put', e.data);
          return;
        }
        const initData = {};
        initData[dataKind.features.namespace] = all.data.flags;
        initData[dataKind.segments.namespace] = all.data.segments;
        featureStore.init(initData);
        cb();
      } else {
        cb(new errors.LDStreamingError('Unexpected payload from event stream'));
      }
    });

    es.addEventListener('patch', e => {
      config.logger.debug('Received patch event');
      if (e && e.data) {
        let patch;
        try {
          patch = JSON.parse(e.data);
        } catch (err) {
          reportJsonError('patch', e.data);
          return;
        }
        for (const k in dataKind) {
          const kind = dataKind[k];
          const key = getKeyFromPath(kind, patch.path);
          if (key !== null) {
            config.logger.debug('Updating ' + key + ' in ' + kind.namespace);
            featureStore.upsert(kind, patch.data);
            break;
          }
        }
      } else {
        cb(new errors.LDStreamingError('Unexpected payload from event stream'));
      }
    });

    es.addEventListener('delete', e => {
      config.logger.debug('Received delete event');
      if (e && e.data) {
        let data;
        try {
          data = JSON.parse(e.data);
        } catch (err) {
          reportJsonError('delete', e.data);
          return;
        }
        const version = data.version;
        for (const k in dataKind) {
          const kind = dataKind[k];
          const key = getKeyFromPath(kind, data.path);
          if (key !== null) {
            config.logger.debug('Deleting ' + key + ' in ' + kind.namespace);
            featureStore.delete(kind, key, version);
            break;
          }
        }
      } else {
        cb(new errors.LDStreamingError('Unexpected payload from event stream'));
      }
    });

    es.addEventListener('indirect/put', () => {
      config.logger.debug('Received indirect put event');
      requestor.requestAllData((err, resp) => {
        if (err) {
          cb(err);
        } else {
          const all = JSON.parse(resp);
          const initData = {};
          initData[dataKind.features.namespace] = all.flags;
          initData[dataKind.segments.namespace] = all.segments;
          featureStore.init(initData);
          cb();
        }
      });
    });

    es.addEventListener('indirect/patch', e => {
      config.logger.debug('Received indirect patch event');
      if (e && e.data) {
        const path = e.data;
        for (const k in dataKind) {
          const kind = dataKind[k];
          const key = getKeyFromPath(kind, path);
          if (key !== null) {
            requestor.requestObject(kind, key, (err, resp) => {
              if (err) {
                cb(new errors.LDStreamingError('Unexpected error requesting ' + key + ' in ' + kind.namespace));
              } else {
                config.logger.debug('Updating ' + key + ' in ' + kind.namespace);
                featureStore.upsert(kind, JSON.parse(resp));
              }
            });
            break;
          }
        }
      } else {
        cb(new errors.LDStreamingError('Unexpected payload from event stream'));
      }
    });
  };

  processor.stop = () => {
    if (es) {
      es.close();
    }
  };

  processor.close = () => {
    processor.stop();
  };

  return processor;
}

module.exports = StreamProcessor;
