var evaluate = require('../evaluate_flag');
var EventFactory = require('../event_factory');
var InMemoryFeatureStore = require('../feature_store');
var dataKind = require('../versioned_data_kind');

var featureStore = new InMemoryFeatureStore();
var eventFactory = EventFactory(false);

function defineFeatures(features) {
  var data = {};
  data[dataKind.features.namespace] = {};
  for (var i in features) {
    data[dataKind.features.namespace][features[i].key] = features[i];
  }
  featureStore.init(data);
}

function defineSegment(segment) {
  var data = {};
  data[dataKind.segments.namespace] = {};
  data[dataKind.segments.namespace][segment.key] = segment;
  featureStore.init(data);
}

function makeFlagWithRules(rules, fallthrough) {
  if (!fallthrough) {
    fallthrough = { variation: 0 };
  }
  return {
    key: 'feature',
    on: true,
    rules: rules,
    targets: [],
    fallthrough: fallthrough,
    offVariation: 1,
    variations: ['a', 'b', 'c']
  };
}

function makeBooleanFlagWithRules(rules) {
  return {
    key: 'feature',
    on: true,
    prerequisites: [],
    rules: rules,
    targets: [],
    salt: '',
    fallthrough: { variation: 0 },
    offVariation: 0,
    variations: [false, true],
    version: 1
  };
}

function makeBooleanFlagWithOneClause(clause) {
  return makeBooleanFlagWithRules([{ clauses: [clause], variation: 1 }]);
}

function makeFlagWithSegmentMatch(segment) {
  return makeBooleanFlagWithOneClause({ attribute: '', op: 'segmentMatch', values: [segment.key] });
}

describe('AAAA evaluate', () => {

  it('returns off variation if flag is off', () => {
    var flag = {
      key: 'feature',
      on: false,
      offVariation: 1,
      fallthrough: { variation: 0 },
      variations: ['a', 'b', 'c']
    };
    var user = { key: 'x' };
    const { detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(detail).toMatchObject({ value: 'b', variationIndex: 1, reason: { kind: 'OFF' } });
    expect(events).toMatchObject([]);
  });

  it('returns null if flag is off and off variation is unspecified', () => {
    var flag = {
      key: 'feature',
      on: false,
      fallthrough: { variation: 0 },
      variations: ['a', 'b', 'c']
    };
    var user = { key: 'x' };
    const { detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(detail).toMatchObject({ value: null, variationIndex: null, reason: { kind: 'OFF' } });
    expect(events).toMatchObject([]);
  });

  it('returns error if off variation is too high', () => {
    var flag = {
      key: 'feature',
      on: false,
      offVariation: 99,
      fallthrough: { variation: 0 },
      variations: ['a', 'b', 'c']
    };
    var user = { key: 'x' };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(err).toEqual(Error('Invalid variation index in flag'));
    expect(detail).toMatchObject({ value: null, variationIndex: null, reason: { kind: 'ERROR', errorKind: 'MALFORMED_FLAG' } });
    expect(events).toMatchObject([]);
  });

  it('returns error if off variation is negative', () => {
    var flag = {
      key: 'feature',
      on: false,
      offVariation: -1,
      fallthrough: { variation: 0 },
      variations: ['a', 'b', 'c']
    };
    var user = { key: 'x' };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(err).toEqual(Error('Invalid variation index in flag'));
    expect(detail).toMatchObject({ value: null, variationIndex: null, reason: { kind: 'ERROR', errorKind: 'MALFORMED_FLAG' } });
    expect(events).toMatchObject([]);
  });

  it('returns fallthrough variation if flag is on and no rules match', () => {
    var rule = { id: 'id', clauses: [{ attribute: 'key', op: 'in', values: ['other'] }], variation: 2 };
    var flag = makeFlagWithRules([rule], { variation: 0 });
    var user = { key: 'x' };
    const { detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(detail).toMatchObject({ value: 'a', variationIndex: 0, reason: { kind: 'FALLTHROUGH' } });
    expect(events).toMatchObject([]);
  });

  it('returns error if fallthrough variation is too high', () => {
    var rule = { id: 'id', clauses: [{ attribute: 'key', op: 'in', values: ['other'] }], variation: 99 };
    var flag = makeFlagWithRules([rule], { variation: 99 });
    var user = { key: 'x' };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(err).toEqual(Error('Invalid variation index in flag'));
    expect(detail).toMatchObject({ value: null, variationIndex: null, reason: { kind: 'ERROR', errorKind: 'MALFORMED_FLAG' } });
    expect(events).toMatchObject([]);
  });

  it('returns error if fallthrough variation is negative', () => {
    var rule = { id: 'id', clauses: [{ attribute: 'key', op: 'in', values: ['other'] }], variation: 99 };
    var flag = makeFlagWithRules([rule], { variation: -1 });
    var user = { key: 'x' };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(err).toEqual(Error('Invalid variation index in flag'));
    expect(detail).toMatchObject({ value: null, variationIndex: null, reason: { kind: 'ERROR', errorKind: 'MALFORMED_FLAG' } });
    expect(events).toMatchObject([]);
  });

  it('returns error if fallthrough has no variation or rollout', () => {
    var rule = { id: 'id', clauses: [{ attribute: 'key', op: 'in', values: ['other'] }], variation: 99 };
    var flag = makeFlagWithRules([rule], {});
    var user = { key: 'x' };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(err).toEqual(Error('Variation/rollout object with no variation or rollout'));
    expect(detail).toMatchObject({ value: null, variationIndex: null, reason: { kind: 'ERROR', errorKind: 'MALFORMED_FLAG' } });
    expect(events).toMatchObject([]);
  });

  it('returns error if fallthrough has rollout with no variations', () => {
    var rule = { id: 'id', clauses: [{ attribute: 'key', op: 'in', values: ['other'] }], variation: 99 };
    var flag = makeFlagWithRules([rule], { rollout: { variations: [] } });
    var user = { key: 'x' };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(err).toEqual(Error('Variation/rollout object with no variation or rollout'));
    expect(detail).toMatchObject({ value: null, variationIndex: null, reason: { kind: 'ERROR', errorKind: 'MALFORMED_FLAG' } });
    expect(events).toMatchObject([]);
  });

  it('returns off variation if prerequisite is not found', () => {
    var flag = {
      key: 'feature0',
      on: true,
      prerequisites: [{ key: 'badfeature', variation: 1 }],
      fallthrough: { variation: 0 },
      offVariation: 1,
      variations: ['a', 'b', 'c']
    };
    var user = { key: 'x' };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(detail).toMatchObject({
      value: 'b', variationIndex: 1,
      reason: { kind: 'PREREQUISITE_FAILED', prerequisiteKey: 'badfeature' }
    });
    expect(events).toMatchObject([]);
  });

  it('returns off variation and event if prerequisite is off', () => {
    var flag = {
      key: 'feature0',
      on: true,
      prerequisites: [{ key: 'feature1', variation: 1 }],
      fallthrough: { variation: 0 },
      offVariation: 1,
      targets: [],
      rules: [],
      variations: ['a', 'b', 'c'],
      version: 1
    };
    var flag1 = {
      key: 'feature1',
      on: false,
      offVariation: 1,
      // note that even though it returns the desired variation, it is still off and therefore not a match
      fallthrough: { variation: 0 },
      targets: [],
      rules: [],
      variations: ['d', 'e'],
      version: 2
    };
    defineFeatures([flag, flag1]);
    var user = { key: 'x' };
    var eventsShouldBe = [
      { kind: 'feature', key: 'feature1', variation: 1, value: 'e', version: 2, prereqOf: 'feature0' }
    ];
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(detail).toMatchObject({
      value: 'b', variationIndex: 1,
      reason: { kind: 'PREREQUISITE_FAILED', prerequisiteKey: 'feature1' }
    });
    expect(events).toMatchObject(eventsShouldBe);
  });

  it('returns off variation and event if prerequisite is not met', () => {
    var flag = {
      key: 'feature0',
      on: true,
      prerequisites: [{ key: 'feature1', variation: 1 }],
      fallthrough: { variation: 0 },
      offVariation: 1,
      targets: [],
      rules: [],
      variations: ['a', 'b', 'c'],
      version: 1
    };
    var flag1 = {
      key: 'feature1',
      on: true,
      fallthrough: { variation: 0 },
      targets: [],
      rules: [],
      variations: ['d', 'e'],
      version: 2
    };
    defineFeatures([flag, flag1]);
    var user = { key: 'x' };
    var eventsShouldBe = [
      { kind: 'feature', key: 'feature1', variation: 0, value: 'd', version: 2, prereqOf: 'feature0' }
    ];
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(detail).toMatchObject({
      value: 'b', variationIndex: 1,
      reason: { kind: 'PREREQUISITE_FAILED', prerequisiteKey: 'feature1' }
    });
    expect(events).toMatchObject(eventsShouldBe);
  });

  it('returns fallthrough variation and event if prerequisite is met and there are no rules', () => {
    var flag = {
      key: 'feature0',
      on: true,
      prerequisites: [{ key: 'feature1', variation: 1 }],
      fallthrough: { variation: 0 },
      offVariation: 1,
      targets: [],
      rules: [],
      variations: ['a', 'b', 'c'],
      version: 1
    };
    var flag1 = {
      key: 'feature1',
      on: true,
      fallthrough: { variation: 1 },
      targets: [],
      rules: [],
      variations: ['d', 'e'],
      version: 2
    };
    defineFeatures([flag, flag1]);
    var user = { key: 'x' };
    var eventsShouldBe = [
      { kind: 'feature', key: 'feature1', variation: 1, value: 'e', version: 2, prereqOf: 'feature0' }
    ];
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(detail).toMatchObject({ value: 'a', variationIndex: 0, reason: { kind: 'FALLTHROUGH' } });
    expect(events).toMatchObject(eventsShouldBe);
  });

  it('matches user from rules', () => {
    var rule0 = { id: 'id0', clauses: [{ attribute: 'key', op: 'in', values: ['nope'] }], variation: 1 };
    var rule1 = { id: 'id1', clauses: [{ attribute: 'key', op: 'in', values: ['userkey'] }], variation: 2 };
    var flag = makeFlagWithRules([rule0, rule1]);
    var user = { key: 'userkey' };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(detail).toMatchObject({
      value: 'c', variationIndex: 2,
      reason: { kind: 'RULE_MATCH', ruleIndex: 1, ruleId: 'id1' }
    });
    expect(events).toMatchObject([]);
  });

  it('returns error if rule variation is too high', () => {
    var rule = { id: 'id', clauses: [{ attribute: 'key', op: 'in', values: ['userkey'] }], variation: 99 };
    var flag = makeFlagWithRules([rule]);
    var user = { key: 'userkey' };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(err).toEqual(Error('Invalid variation index in flag'));
    expect(detail).toMatchObject({ value: null, variationIndex: null, reason: { kind: 'ERROR', errorKind: 'MALFORMED_FLAG' } });
    expect(events).toMatchObject([]);
  });

  it('returns error if rule variation is negative', () => {
    var rule = { id: 'id', clauses: [{ attribute: 'key', op: 'in', values: ['userkey'] }], variation: -1 };
    var flag = makeFlagWithRules([rule]);
    var user = { key: 'userkey' };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(err).toEqual(Error('Invalid variation index in flag'));
    expect(detail).toMatchObject({ value: null, variationIndex: null, reason: { kind: 'ERROR', errorKind: 'MALFORMED_FLAG' } });
    expect(events).toMatchObject([]);
  });

  it('returns error if rule has no variation or rollout', () => {
    var rule = { id: 'id', clauses: [{ attribute: 'key', op: 'in', values: ['userkey'] }] };
    var flag = makeFlagWithRules([rule]);
    var user = { key: 'userkey' };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(err).toEqual(Error('Variation/rollout object with no variation or rollout'));
    expect(detail).toMatchObject({ value: null, variationIndex: null, reason: { kind: 'ERROR', errorKind: 'MALFORMED_FLAG' } });
    expect(events).toMatchObject([]);
  });

  it('returns error if rule has rollout with no variations', () => {
    var rule = { id: 'id', clauses: [{ attribute: 'key', op: 'in', values: ['userkey'] }], rollout: { variations: [] } };
    var flag = makeFlagWithRules([rule]);
    var user = { key: 'userkey' };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(err).toEqual(Error('Variation/rollout object with no variation or rollout'));
    expect(detail).toMatchObject({ value: null, variationIndex: null, reason: { kind: 'ERROR', errorKind: 'MALFORMED_FLAG' } });
    expect(events).toMatchObject([]);
  });

  it('coerces user key to string', () => {
    var clause = { 'attribute': 'key', 'op': 'in', 'values': ['999'] };
    var flag = makeBooleanFlagWithOneClause(clause);
    var user = { 'key': 999 };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(detail.value).toBe(true);
  });

  it('coerces secondary key to string', () => {
    // We can't really verify that the rollout calculation works correctly, but we can at least
    // make sure it doesn't error out if there's a non-string secondary value (ch35189)
    var rule = {
      id: 'ruleid',
      clauses: [
        { attribute: 'key', op: 'in', values: ['userkey'] }
      ],
      rollout: {
        salt: '',
        variations: [{ weight: 100000, variation: 1 }]
      }
    };
    var flag = makeBooleanFlagWithRules([rule]);
    var user = { key: 'userkey', secondary: 999 };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(detail.value).toBe(true);
  });

  it('matches user from targets', () => {
    var flag = {
      key: 'feature0',
      on: true,
      rules: [],
      targets: [
        {
          variation: 2,
          values: ['some', 'userkey', 'or', 'other']
        }
      ],
      fallthrough: { variation: 0 },
      offVariation: 1,
      variations: ['a', 'b', 'c']
    };
    var user = { key: 'userkey' };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(detail).toMatchObject({ value: 'c', variationIndex: 2, reason: { kind: 'TARGET_MATCH' } });
    expect(events).toMatchObject([]);
  });

  function testClauseMatch(clause, user, shouldBe) {
    var flag = makeBooleanFlagWithOneClause(clause);
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(detail.value).toBe(shouldBe);
  }

  it('can match built-in attribute', () => {
    var user = { key: 'x', name: 'Bob' };
    var clause = { attribute: 'name', op: 'in', values: ['Bob'] };
    testClauseMatch(clause, user, true);
  });

  it('can match custom attribute', () => {
    var user = { key: 'x', name: 'Bob', custom: { legs: 4 } };
    var clause = { attribute: 'legs', op: 'in', values: [4] };
    testClauseMatch(clause, user, true);
  });

  it('does not match missing attribute', () => {
    var user = { key: 'x', name: 'Bob' };
    var clause = { attribute: 'legs', op: 'in', values: [4] };
    testClauseMatch(clause, user, false);
  });

  it('can have a negated clause', () => {
    var user = { key: 'x', name: 'Bob' };
    var clause = { attribute: 'name', op: 'in', values: ['Bob'], negate: true };
    testClauseMatch(clause, user, false);
  });

  it('matches segment with explicitly included user', () => {
    var segment = {
      key: 'test',
      included: ['foo'],
      version: 1
    };
    defineSegment(segment);
    var flag = makeFlagWithSegmentMatch(segment);
    var user = { key: 'foo' };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(detail.value).toBe(true);
  });

  it('does not match segment with explicitly excluded user', () => {
    var segment = {
      key: 'test',
      excluded: ['foo'],
      version: 1
    };
    defineSegment(segment);
    var flag = makeFlagWithSegmentMatch(segment);
    var user = { key: 'foo' };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(detail.value).toBe(false);
  });

  it('does not match segment with unknown user', () => {
    var segment = {
      key: 'test',
      included: ['foo'],
      version: 1
    };
    defineSegment(segment);
    var flag = makeFlagWithSegmentMatch(segment);
    var user = { key: 'bar' };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(detail.value).toBe(false);
  });

  it('matches segment with user who is both included and excluded', () => {
    var segment = {
      key: 'test',
      included: ['foo'],
      excluded: ['foo'],
      version: 1
    };
    defineSegment(segment);
    var flag = makeFlagWithSegmentMatch(segment);
    var user = { key: 'foo' };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(detail.value).toBe(true);
  });

  it('matches segment with rule with full rollout', () => {
    var segment = {
      key: 'test',
      rules: [
        {
          clauses: [
            {
              attribute: 'email',
              op: 'in',
              values: ['test@example.com']
            }
          ],
          weight: 100000
        }
      ],
      version: 1
    };
    defineSegment(segment);
    var flag = makeFlagWithSegmentMatch(segment);
    var user = { key: 'foo', email: 'test@example.com' };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(detail.value).toBe(true);
  });

  it('does not match segment with rule with zero rollout', () => {
    var segment = {
      key: 'test',
      rules: [
        {
          clauses: [
            {
              attribute: 'email',
              op: 'in',
              values: ['test@example.com']
            }
          ],
          weight: 0
        }
      ],
      version: 1
    };
    defineSegment(segment);
    var flag = makeFlagWithSegmentMatch(segment);
    var user = { key: 'foo', email: 'test@example.com' };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(detail.value).toBe(false);
  });

  it('matches segment with multiple matching clauses', () => {
    var segment = {
      key: 'test',
      rules: [
        {
          clauses: [
            {
              attribute: 'email',
              op: 'in',
              values: ['test@example.com']
            },
            {
              attribute: 'name',
              op: 'in',
              values: ['bob']
            }
          ]
        }
      ],
      version: 1
    };
    defineSegment(segment);
    var flag = makeFlagWithSegmentMatch(segment);
    var user = { key: 'foo', email: 'test@example.com', name: 'bob' };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(detail.value).toBe(true);
  });

  it('does not match segment if one clause does not match', () => {
    var segment = {
      key: 'test',
      rules: [
        {
          clauses: [
            {
              attribute: 'email',
              op: 'in',
              values: ['test@example.com']
            },
            {
              attribute: 'name',
              op: 'in',
              values: ['bill']
            }
          ]
        }
      ],
      version: 1
    };
    defineSegment(segment);
    var flag = makeFlagWithSegmentMatch(segment);
    var user = { key: 'foo', email: 'test@example.com', name: 'bob' };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(detail.value).toBe(false);
  });

  it('does not overflow the call stack when evaluating a huge number of rules', () => {
    var ruleCount = 5000;
    var flag = {
      key: 'flag',
      targets: [],
      on: true,
      variations: [false, true],
      fallthrough: { variation: 0 }
    };
    var clause = {
      attribute: 'key',
      op: 'in',
      values: ['x']
    };
    // Note, for this test to be meaningful, the rules must *not* match the user, since we
    // stop evaluating rules on the first match.
    var rules = [];
    for (var i = 0; i < ruleCount; i++) {
      rules.push({ clauses: [clause], variation: 1 });
    }
    flag.rules = rules;
    const { err, detail, events } = evaluate.evaluate(flag, { key: 'user' }, featureStore, eventFactory);
    expect(err).toEqual(null);
    expect(detail.value).toEqual(false);
  });

  it('does not overflow the call stack when evaluating a huge number of clauses', () => {
    var clauseCount = 5000;
    var flag = {
      key: 'flag',
      targets: [],
      on: true,
      variations: [false, true],
      fallthrough: { variation: 0 }
    };
    // Note, for this test to be meaningful, the clauses must all match the user, since we
    // stop evaluating clauses on the first non-match.
    var clause = {
      attribute: 'key',
      op: 'in',
      values: ['user']
    };
    var clauses = [];
    for (var i = 0; i < clauseCount; i++) {
      clauses.push(clause);
    }
    var rule = { clauses: clauses, variation: 1 };
    flag.rules = [rule];
    const { err, detail, events } = evaluate.evaluate(flag, { key: 'user' }, featureStore, eventFactory);
    expect(err).toEqual(null);
    expect(detail.value).toEqual(true);
  });
});

describe('rollout', () => {
  it('selects bucket', () => {
    const user = { key: 'userkey' };
    const flagKey = 'flagkey';
    const salt = 'salt';

    // First verify that with our test inputs, the bucket value will be greater than zero and less than 100000,
    // so we can construct a rollout whose second bucket just barely contains that value
    const bucketValue = Math.floor(evaluate.bucketUser(user, flagKey, 'key', salt) * 100000);
    expect(bucketValue).toBeGreaterThan(0);
    expect(bucketValue).toBeLessThan(100000);

    const badVariationA = 0, matchedVariation = 1, badVariationB = 2;
    const rollout = {
      variations: [
        { variation: badVariationA, weight: bucketValue }, // end of bucket range is not inclusive, so it will *not* match the target value
        { variation: matchedVariation, weight: 1 }, // size of this bucket is 1, so it only matches that specific value
        { variation: badVariationB, weight: 100000 - (bucketValue + 1) }
      ]
    };
    const flag = {
      key: flagKey,
      salt: salt,
      on: true,
      fallthrough: { rollout: rollout },
      variations: [null, null, null]
    };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(err).toEqual(null);
    expect(detail.variationIndex).toEqual(matchedVariation);
  });

  it('uses last bucket if bucket value is equal to total weight', () => {
    const user = { key: 'userkey' };
    const flagKey = 'flagkey';
    const salt = 'salt';

    // We'll construct a list of variations that stops right at the target bucket value
    const bucketValue = Math.floor(evaluate.bucketUser(user, flagKey, 'key', salt) * 100000);

    const rollout = {
      variations: [{ variation: 0, weight: bucketValue }]
    };
    const flag = {
      key: flagKey,
      salt: salt,
      on: true,
      fallthrough: { rollout: rollout },
      variations: [null, null, null]
    };
    const { err, detail, events } = evaluate.evaluate(flag, user, featureStore, eventFactory);
    expect(err).toEqual(null);
    expect(detail.variationIndex).toEqual(0);
  });
});

describe('bucketUser', () => {
  it('gets expected bucket values for specific keys', () => {
    var user = { key: 'userKeyA' };
    var bucket = evaluate.bucketUser(user, 'hashKey', 'key', 'saltyA');
    expect(bucket).toBeCloseTo(0.42157587, 7);

    user = { key: 'userKeyB' };
    bucket = evaluate.bucketUser(user, 'hashKey', 'key', 'saltyA');
    expect(bucket).toBeCloseTo(0.6708485, 7);

    user = { key: 'userKeyC' };
    bucket = evaluate.bucketUser(user, 'hashKey', 'key', 'saltyA');
    expect(bucket).toBeCloseTo(0.10343106, 7);
  });

  it('can bucket by int value (equivalent to string)', () => {
    var user = {
      key: 'userKey',
      custom: {
        intAttr: 33333,
        stringAttr: '33333'
      }
    };
    var bucket = evaluate.bucketUser(user, 'hashKey', 'intAttr', 'saltyA');
    var bucket2 = evaluate.bucketUser(user, 'hashKey', 'stringAttr', 'saltyA');
    expect(bucket).toBeCloseTo(0.54771423, 7);
    expect(bucket2).toBe(bucket);
  });

  it('cannot bucket by float value', () => {
    var user = {
      key: 'userKey',
      custom: {
        floatAttr: 33.5
      }
    };
    var bucket = evaluate.bucketUser(user, 'hashKey', 'floatAttr', 'saltyA');
    expect(bucket).toBe(0);
  });
});
