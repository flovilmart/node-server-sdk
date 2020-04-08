// The default in-memory implementation of a feature store, which holds feature flags and
// other related data received from LaunchDarkly.
//
// Other implementations of the same interface can be used by passing them in the featureStore
// property of the client configuration (that's why the interface here is async, even though
// the in-memory store doesn't do anything asynchronous - because other implementations may
// need to be async). The interface is defined by LDFeatureStore in index.d.ts. There is a
// Redis-backed implementation in RedisFeatureStore; for other options, see
// [https://docs.launchdarkly.com/v2.0/docs/using-a-persistent-feature-store].
//
// Additional implementations should use CachingStoreWrapper if possible.

// Note that the contract for feature store methods does *not* require callbacks to be deferred
// with setImmediate, process.nextTick, etc. It is both allowed and desirable to call them
// directly whenever possible (i.e. if we don't actually have to do any I/O), since otherwise
// feature flag retrieval is a major performance bottleneck. These methods are for internal use
// by the SDK, and the SDK does not make any assumptions about whether a callback executes
// before or after the next statement.

function InMemoryFeatureStore() {
  let allData = {};
  let initCalled = false;

  const store = {};

  store.get = (kind, key) => {
    const items = allData[kind.namespace] || {};
    if (Object.hasOwnProperty.call(items, key)) {
      const item = items[key];

      if (!item || item.deleted) {
        return null;
      } else {
        return item;
      }
    } else {
      return null;
    }
  };

  store.all = kind => {
    const results = {};
    const items = allData[kind.namespace] || {};

    for (const key in items) {
      if (Object.hasOwnProperty.call(items, key)) {
        const item = items[key];
        if (item && !item.deleted) {
          results[key] = item;
        }
      }
    }

    return results;
  };

  store.init = newData => {
    allData = newData;
    initCalled = true;
  };

  store.delete = (kind, key, version) => {
    let items = allData[kind.namespace];
    if (!items) {
      items = {};
      allData[kind] = items;
    }
    const deletedItem = { version: version, deleted: true };
    if (Object.hasOwnProperty.call(items, key)) {
      const old = items[key];
      if (!old || old.version < version) {
        items[key] = deletedItem;
      }
    } else {
      items[key] = deletedItem;
    }
  };

  store.upsert = (kind, item) => {
    const key = item.key;
    let items = allData[kind.namespace];
    if (!items) {
      items = {};
      allData[kind.namespace] = items;
    }

    if (Object.hasOwnProperty.call(items, key)) {
      const old = items[key];
      if (old && old.version < item.version) {
        items[key] = clone(item);
      }
    } else {
      items[key] = clone(item);
    }
  };

  store.initialized = () => initCalled === true;

  store.close = () => {
    // Close on the in-memory store is a no-op
  };

  store.description = 'memory';

  return store;
}

// Deep clone an object. Does not preserve any
// functions on the object
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

module.exports = InMemoryFeatureStore;
