var dataKind = require('../versioned_data_kind');

// The following tests should be run on every feature store implementation. If this type of
// store supports caching, the tests should be run once with caching enabled and once with
// caching disabled.
//
// Parameters:
// - makeStore(): creates an instance of the feature store
// - clearExistingData(callback): if specified, will be called before each test to clear any
// storage that the store instances may be sharing; this also implies that the feature store
// - isCached: true if the instances returned by makeStore() have caching enabled.
// - makeStoreWithPrefix(prefix): creates an uncached instance of the store with a key prefix

function baseFeatureStoreTests(makeStore, clearExistingData, isCached, makeStoreWithPrefix) {
  var feature1 = {
    key: 'foo',
    version: 10
  };
  var feature2 = {
    key: 'bar',
    version: 10
  };

  beforeEach(done => {
    if (clearExistingData) {
      clearExistingData(done);
    } else {
      done();
    }
  });

  function initedStore() {
    var store = makeStore();
    var initData = {};
    initData[dataKind.features.namespace] = {
      'foo': feature1,
      'bar': feature2
    };
    store.init(initData);
    return store;
  }

  it('is initialized after calling init()', () => {
    var store = initedStore();
    var result = store.initialized();
    expect(result).toBe(true);
  });

  it('init() completely replaces previous data', () => {
    var store = makeStore();
    var flags = {
      first: { key: 'first', version: 1 },
      second: { key: 'second', version: 1 }
    };
    var segments = { first: { key: 'first', version: 2 } };
    var initData = {};
    initData[dataKind.features.namespace] = flags;
    initData[dataKind.segments.namespace] = segments;

    store.init(initData);
    var items = store.all(dataKind.features);
    expect(items).toEqual(flags);
    items = store.all(dataKind.segments);
    expect(items).toEqual(segments);

    var newFlags = { first: { key: 'first', version: 3 } };
    var newSegments = { first: { key: 'first', version: 4 } };
    var initData = {};
    initData[dataKind.features.namespace] = newFlags;
    initData[dataKind.segments.namespace] = newSegments;

    store.init(initData);
    items = store.all(dataKind.features);
    expect(items).toEqual(newFlags);
    items = store.all(dataKind.segments);
    expect(items).toEqual(newSegments);
  });

  if (!isCached && clearExistingData) {
    function testInitStateDetection(desc, initData) {
      it(desc, () => {
        var store1 = makeStore();
        var store2 = makeStore();

        var result = store1.initialized();
        expect(result).toBe(false);

        store2.init(initData);
        result = store1.initialized();
        expect(result).toBe(true);
      });
    }

    testInitStateDetection('can detect if another instance has initialized the store',
      { features: { foo: feature1 } });

    testInitStateDetection('can detect if another instance has initialized the store, even with empty data',
      { features: {} });

    if (makeStoreWithPrefix) {
      it('is independent from other instances with different prefixes', () => {
        var flag = { key: 'flag', version: 1 };
        var storeA = makeStoreWithPrefix('a');
        storeA.init({ features: { flag: flag } });
        var storeB = makeStoreWithPrefix('b');
        storeB.init({ features: {} });
        var storeB1 = makeStoreWithPrefix('b');  // this ensures we're not just reading cached data
        var item = storeB1.get(dataKind.features, 'flag');
        expect(item).toBe(null);
        item = storeA.get(dataKind.features, 'flag');
        expect(item).toEqual(flag);
      });
    }
  }

  it('gets existing feature', () => {
    var store = initedStore();
    var result = store.get(dataKind.features, feature1.key);
    expect(result).toEqual(feature1);
  });

  it('does not get nonexisting feature', () => {
    var store = initedStore();
    var result = store.get(dataKind.features, 'biz');
    expect(result).toBe(null);
  });

  it('gets all features', () => {
    var store = initedStore();
    var result = store.all(dataKind.features);
    expect(result).toEqual({
      'foo': feature1,
      'bar': feature2
    });
  });

  it('upserts with newer version', () => {
    var newVer = { key: feature1.key, version: feature1.version + 1 };
    var store = initedStore();
    store.upsert(dataKind.features, newVer);
    var result = store.get(dataKind.features, feature1.key);
    expect(result).toEqual(newVer);
  });

  it('does not upsert with older version', () => {
    var oldVer = { key: feature1.key, version: feature1.version - 1 };
    var store = initedStore();
    store.upsert(dataKind.features, oldVer);
    var result = store.get(dataKind.features, feature1.key);
    expect(result).toEqual(feature1);
  });

  it('upserts new feature', () => {
    var newFeature = { key: 'biz', version: 99 };
    var store = initedStore();
    store.upsert(dataKind.features, newFeature);
    var result = store.get(dataKind.features, newFeature.key);
    expect(result).toEqual(newFeature);
  });

 it('handles upsert race condition within same client correctly', () => {
    // Not sure if there is a way to do this one with async/await
    var ver1 = { key: feature1.key, version: feature1.version + 1 };
    var ver2 = { key: feature1.key, version: feature1.version + 2 };
    var store = initedStore();
    var counter = 0;
    var combinedCallback = function () {
      counter++;
      if (counter == 2) {
        var result = store.get(dataKind.features, feature1.key);
        expect(result).toEqual(ver2);
      }
    };
    // Deliberately do not wait for the first upsert to complete before starting the second,
    // so their transactions will be interleaved unless we're correctly serializing updates
    store.upsert(dataKind.features, ver2);
    combinedCallback();
    store.upsert(dataKind.features, ver1);
    combinedCallback();
  });

  it('deletes with newer version', () => {
    var store = initedStore();
    store.delete(dataKind.features, feature1.key, feature1.version + 1);
    var result = store.get(dataKind.features, feature1.key);
    expect(result).toBe(null);
  });

  it('does not delete with older version', () => {
    var store = initedStore();
    store.delete(dataKind.features, feature1.key, feature1.version - 1);
    var result = store.get(dataKind.features, feature1.key);
    expect(result).not.toBe(null);
  });

  it('allows deleting unknown feature', () => {
    var store = initedStore();
    store.delete(dataKind.features, 'biz', 99);
    var result = store.get(dataKind.features, 'biz');
    expect(result).toBe(null);
  });

  it('does not upsert older version after delete', () => {
    var store = initedStore();
    store.delete(dataKind.features, feature1.key, feature1.version + 1);
    store.upsert(dataKind.features, feature1);
    var result = store.get(dataKind.features, feature1.key);
    expect(result).toBe(null);
  });
}

// The following tests require that the feature store can be instrumented in such a way as to run
// some test code in the middle of an upsert operation.
//
// Parameters:
// - makeStore(): creates a normal feature store.
// - makeStoreWithHook(hook): creates a feature store that operates on the same underlying data as
// the first store. This store will call the hook function (passing a callback) immediately before
// it attempts to make any update.

function concurrentModificationTests(makeStore, makeStoreWithHook) {

  var flagKey = 'flag';
  var initialVersion = 1;

  var competingStore = makeStore();

  function makeFlagWithVersion(v) {
    return { key: flagKey, version: v };
  }

  function initStore(store) {
    var allData = { features: {} };
    allData['features'][flagKey] = makeFlagWithVersion(initialVersion);
    store.init(allData);
  }

  function writeCompetingVersions(flagVersionsToWrite) {
    var i = 0;
    return function (callback) {
      if (i < flagVersionsToWrite.length) {
        var newFlag = makeFlagWithVersion(flagVersionsToWrite[i]);
        i++;
        competingStore.upsert(dataKind.features, newFlag, callback);
      } else {
        callback();
      }
    };
  }

  it('handles upsert race condition against other client with lower version', () => {
    var myDesiredVersion = 10;
    var competingStoreVersions = [2, 3, 4]; // proves that we can retry multiple times if necessary

    var myStore = makeStoreWithHook(writeCompetingVersions(competingStoreVersions));

    initStore(myStore);
    myStore.upsert(dataKind.features, makeFlagWithVersion(myDesiredVersion));
    var result = myStore.get(dataKind.features, flagKey);
    expect(result.version).toEqual(myDesiredVersion);
  });

  it('handles upsert race condition against other client with higher version', () => {
    var myDesiredVersion = 2;
    var competingStoreVersion = 3;

    var myStore = makeStoreWithHook(writeCompetingVersions([competingStoreVersion]));

    initStore(myStore);
    myStore.upsert(dataKind.features, makeFlagWithVersion(myDesiredVersion));
    var result = myStore.get(dataKind.features, flagKey);
    expect(result.version).toEqual(competingStoreVersion);
  });
}

module.exports = {
  baseFeatureStoreTests: baseFeatureStoreTests,
  concurrentModificationTests: concurrentModificationTests
};

