const FeatureStoreEventWrapper = require('./feature_store_event_wrapper');
const FileDataSource = require('./file_data_source');
const Requestor = require('./requestor');
const EventEmitter = require('events').EventEmitter;
const EventFactory = require('./event_factory');
const EventProcessor = require('./event_processor');
const PollingProcessor = require('./polling');
const StreamingProcessor = require('./streaming');
const FlagsStateBuilder = require('./flags_state');
const configuration = require('./configuration');
const diagnostics = require('./diagnostic_events');
const evaluate = require('./evaluate_flag');
const messages = require('./messages');
const tunnel = require('tunnel');
const crypto = require('crypto');
const errors = require('./errors');
const wrapPromiseCallback = require('./utils/wrapPromiseCallback');
const dataKind = require('./versioned_data_kind');

function createErrorReporter(emitter, logger) {
  return error => {
    if (!error) {
      return;
    }

    if (emitter.listenerCount('error')) {
      emitter.emit('error', error);
    } else {
      logger.error(error.message);
    }
  };
}

global.setImmediate = global.setImmediate || process.nextTick.bind(process);

function NullEventProcessor() {
  return {
    sendEvent: () => {},
    flush: callback => wrapPromiseCallback(Promise.resolve(), callback),
    close: () => {},
  };
}

function NullUpdateProcessor() {
  return {
    start: callback => {
      setImmediate(callback, null); // the start() callback should always be deferred
    },
    close: () => {},
  };
}

const newClient = function(sdkKey, originalConfig) {
  const client = new EventEmitter();
  let initComplete = false,
    failure,
    requestor,
    updateProcessor,
    eventProcessor;

  const config = configuration.validate(originalConfig);

  // Initialize global tunnel if proxy options are set
  if (config.proxyHost && config.proxyPort) {
    config.proxyAgent = createProxyAgent(config);
  }

  config.featureStore = FeatureStoreEventWrapper(config.featureStore, client);

  const maybeReportError = createErrorReporter(client, config.logger);

  let diagnosticsManager = null;

  const eventFactoryDefault = EventFactory(false);
  const eventFactoryWithReasons = EventFactory(true);

  if (config.eventProcessor) {
    eventProcessor = config.eventProcessor;
  } else {
    if (config.offline || !config.sendEvents) {
      eventProcessor = NullEventProcessor();
    } else {
      const diagnosticId = diagnostics.DiagnosticId(sdkKey);
      diagnosticsManager = diagnostics.DiagnosticsManager(config, diagnosticId, new Date().getTime());
      eventProcessor = EventProcessor(sdkKey, config, maybeReportError, diagnosticsManager);
    }
  }

  if (!sdkKey && !config.offline) {
    throw new Error('You must configure the client with an SDK key');
  }

  const createDefaultUpdateProcessor = config => {
    if (config.useLdd || config.offline) {
      return NullUpdateProcessor();
    } else {
      requestor = Requestor(sdkKey, config);

      if (config.stream) {
        config.logger.info('Initializing stream processor to receive feature flag updates');
        return StreamingProcessor(sdkKey, config, requestor, diagnosticsManager);
      } else {
        config.logger.info('Initializing polling processor to receive feature flag updates');
        config.logger.warn('You should only disable the streaming API if instructed to do so by LaunchDarkly support');
        return PollingProcessor(config, requestor);
      }
    }
  };
  let updateProcessorFactory = createDefaultUpdateProcessor;
  if (config.updateProcessor) {
    if (typeof config.updateProcessor === 'function') {
      updateProcessorFactory = config.updateProcessor;
    } else {
      updateProcessor = config.updateProcessor;
    }
  }
  if (!updateProcessor) {
    updateProcessor = updateProcessorFactory(config);
  }

  updateProcessor.start(err => {
    if (err) {
      let error;
      if ((err.status && err.status === 401) || (err.code && err.code === 401)) {
        error = new Error('Authentication failed. Double check your SDK key.');
      } else {
        error = err;
      }

      maybeReportError(error);
      client.emit('failed', error);
      failure = error;
    } else if (!initComplete) {
      initComplete = true;
      client.emit('ready');
    }
  });

  client.initialized = () => initComplete;

  client.waitUntilReady = () => {
    config.logger.warn(messages.deprecated('waitUntilReady', 'waitForInitialization'));

    if (initComplete) {
      return Promise.resolve();
    }

    return new Promise(resolve => {
      client.once('ready', resolve);
    });
  };

  client.waitForInitialization = () => {
    if (initComplete) {
      return Promise.resolve(client);
    }
    if (failure) {
      return Promise.reject(failure);
    }

    return new Promise((resolve, reject) => {
      client.once('ready', () => {
        resolve(client);
      });
      client.once('failed', reject);
    });
  };

  client.variation = (key, user, defaultVal) =>
    evaluateIfPossible(
      key,
      user,
      defaultVal,
      eventFactoryDefault,
    ).value

  client.variationDetail = (key, user, defaultVal) =>
    evaluateIfPossible(key, user, defaultVal, eventFactoryWithReasons)

  function errorResult(errorKind, defaultVal) {
    return { value: defaultVal, variationIndex: null, reason: { kind: 'ERROR', errorKind: errorKind } };
  }

  function evaluateIfPossible(key, user, defaultVal, eventFactory) {
    if (!initComplete) {
      const storeInited = config.featureStore.initialized();
      if (storeInited) {
        config.logger.warn(
          "Variation called before LaunchDarkly client initialization completed (did you wait for the 'ready' event?) - using last known values from feature store"
        );
        return variationInternal(key, user, defaultVal, eventFactory);
      } else {
        const err = new errors.LDClientError(
          "Variation called before LaunchDarkly client initialization completed (did you wait for the 'ready' event?) - using default value"
        );
        maybeReportError(err);
        const result = errorResult('CLIENT_NOT_READY', defaultVal);
        eventProcessor.sendEvent(eventFactory.newUnknownFlagEvent(key, user, result));
        return result;
      }
    } else {
      return variationInternal(key, user, defaultVal, eventFactory);
    }
  }

  // return to a "detail" object with properties "value", "variationIndex", "reason"
  function variationInternal(key, user, defaultVal, eventFactory) {
    if (client.isOffline()) {
      config.logger.info('Variation called in offline mode. Returning default value.');
      return errorResult('CLIENT_NOT_READY', defaultVal);
    } else if (!key) {
      const err = new errors.LDClientError('No feature flag key specified. Returning default value.');
      maybeReportError(err);
      return errorResult('FLAG_NOT_FOUND', defaultVal);
    }

    if (user && user.key === '') {
      config.logger.warn(
        'User key is blank. Flag evaluation will proceed, but the user will not be stored in LaunchDarkly'
      );
    }

    const flag = config.featureStore.get(dataKind.features, key);
    if (!flag) {
      maybeReportError(new errors.LDClientError('Unknown feature flag "' + key + '"; returning default value'));
      const result = errorResult('FLAG_NOT_FOUND', defaultVal);
      eventProcessor.sendEvent(eventFactory.newUnknownFlagEvent(key, user, result));
      return result;
    }

    if (!user) {
      const variationErr = new errors.LDClientError('No user specified. Returning default value.');
      maybeReportError(variationErr);
      const result = errorResult('USER_NOT_SPECIFIED', defaultVal);
      eventProcessor.sendEvent(eventFactory.newDefaultEvent(flag, user, result));
      return result;
    }
    try {
      const { detail, events } = evaluate.evaluate(flag, user, config.featureStore, eventFactory);
      if (events) {
        for (let i = 0; i < events.length; i++) {
          eventProcessor.sendEvent(events[i]);
        }
      }
      if (detail.variationIndex === null) {
        config.logger.debug('Result value is null in variation');
        detail.value = defaultVal;
      }
      eventProcessor.sendEvent(eventFactory.newEvalEvent(flag, user, detail, defaultVal));
      return detail;
    } catch (err) {
      maybeReportError(
        new errors.LDClientError(
          'Encountered error evaluating feature flag:' + (err.message ? ': ' + err.message : err)
        )
      );
    }
  }

  client.allFlags = (user, callback) => {
    config.logger.warn('allFlags() is deprecated. Call allFlagsState() instead and call toJSON() on the result');
    return client.allFlagsState(user).allValues();
  };

  client.allFlagsState = (user, specifiedOptions) => {
    const options = specifiedOptions || {};
    if (client.isOffline()) {
      config.logger.info('allFlagsState() called in offline mode. Returning empty state.');
      return FlagsStateBuilder(false).build();
    }
    if (!user) {
      config.logger.info('allFlagsState() called without user. Returning empty state.');
      return FlagsStateBuilder(false).build();
    }

    const builder = FlagsStateBuilder(true);
    const clientOnly = options.clientSideOnly;
    const withReasons = options.withReasons;
    const detailsOnlyIfTracked = options.detailsOnlyForTrackedFlags;
    const flags = config.featureStore.all(dataKind.features);
    for (const flag of (Object.values(flags) || [])) {
      if (clientOnly && !flag.clientSide) {
        continue;
      }
      const { detail, err } = evaluate.evaluate(flag, user, config.featureStore, eventFactoryDefault);
      if (err !== null) {
        maybeReportError(
          new Error('Error for feature flag "' + flag.key + '" while evaluating all flags: ' + err)
        );
      }
      builder.addFlag(
        flag,
        detail.value,
        detail.variationIndex,
        withReasons ? detail.reason : null,
        detailsOnlyIfTracked
      );
    }
    return builder.build();
  };

  client.secureModeHash = user => {
    const hmac = crypto.createHmac('sha256', sdkKey);
    hmac.update(user.key);
    return hmac.digest('hex');
  };

  client.close = () => {
    eventProcessor.close();
    if (updateProcessor) {
      updateProcessor.close();
    }
    config.featureStore.close();
  };

  client.isOffline = () => config.offline;

  client.track = (eventName, user, data, metricValue) => {
    if (!userExistsAndHasKey(user)) {
      config.logger.warn(messages.missingUserKeyNoEvent());
      return;
    }
    eventProcessor.sendEvent(eventFactoryDefault.newCustomEvent(eventName, user, data, metricValue));
  };

  client.identify = user => {
    if (!userExistsAndHasKey(user)) {
      config.logger.warn(messages.missingUserKeyNoEvent());
      return;
    }
    eventProcessor.sendEvent(eventFactoryDefault.newIdentifyEvent(user));
  };

  client.flush = callback => eventProcessor.flush(callback);

  function userExistsAndHasKey(user) {
    if (user) {
      const key = user.key;
      return key !== undefined && key !== null && key !== '';
    }
    return false;
  }

  function deprecatedMethod(oldName, newName) {
    client[oldName] = (...args) => {
      config.logger.warn(messages.deprecated(oldName, newName));
      return client[newName].apply(client, args);
    };
  }

  deprecatedMethod('all_flags', 'allFlags');
  deprecatedMethod('is_offline', 'isOffline');
  deprecatedMethod('secure_mode_hash', 'secureModeHash');
  deprecatedMethod('toggle', 'variation');

  return client;
};

module.exports = {
  init: newClient,
  FileDataSource: FileDataSource,
  errors: errors,
};

function createProxyAgent(config) {
  const options = {
    proxy: {
      host: config.proxyHost,
      port: config.proxyPort,
      proxyAuth: config.proxyAuth,
    },
  };

  if (config.proxyScheme === 'https') {
    if (!config.baseUri || config.baseUri.startsWith('https')) {
      return tunnel.httpsOverHttps(options);
    } else {
      return tunnel.httpOverHttps(options);
    }
  } else if (!config.baseUri || config.baseUri.startsWith('https')) {
    return tunnel.httpsOverHttp(options);
  } else {
    return tunnel.httpOverHttp(options);
  }
}
