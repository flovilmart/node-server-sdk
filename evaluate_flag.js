const crypto = require('crypto');

const operators = require('./operators');
const dataKind = require('./versioned_data_kind');
const util = require('util');
const stringifyAttrs = require('./utils/stringifyAttrs');
const builtins = ['key', 'ip', 'country', 'email', 'firstName', 'lastName', 'avatar', 'name', 'anonymous'];
const userAttrsToStringifyForEvaluation = ['key', 'secondary'];
// Currently we are not stringifying the rest of the built-in attributes prior to evaluation, only for events.
// This is because it could affect evaluation results for existing users (ch35206).

const noop = () => {};

// Callback receives (err, detail, events) where detail has the properties "value", "variationIndex", and "reason";
// detail will never be null even if there's an error.
function evaluate(flag, user, featureStore, eventFactory) {
  if (!user || user.key === null || user.key === undefined) {
    return {
      err: null,
      detail: errorResult('USER_NOT_SPECIFIED'),
      events: []
    };
  }

  if (!flag) {
    return {
      err: null,
      detail: errorResult('FLAG_NOT_FOUND'),
      events: []
    };
    return;
  }

  const sanitizedUser = stringifyAttrs(user, userAttrsToStringifyForEvaluation);
  const events = [];
  const { err, detail } = evalInternal(flag, sanitizedUser, featureStore, events, eventFactory);
  return { err, detail, events };
}

function evalInternal(flag, user, featureStore, events, eventFactory) {
  // If flag is off, return the off variation
  if (!flag.on) {
    return getOffResult(flag, { kind: 'OFF' });
  }

  const { err, reason } = checkPrerequisites(flag, user, featureStore, events, eventFactory);
  if (err || reason) {
    return getOffResult(flag, reason);
  } else {
    return evalRules(flag, user, featureStore);
  }
}

// Callback receives (err, reason) where reason is null if successful, or a "prerequisite failed" reason
function checkPrerequisites(flag, user, featureStore, events, eventFactory) {
  if (flag.prerequisites && flag.prerequisites.length) {
    for (const prereq of flag.prerequisites) {
      let errInfo;
      const prereqFlag = featureStore.get(dataKind.features, prereq.key);
      if (!prereqFlag) {
        errInfo = {
          key: prereq.key,
          err: new Error('Could not retrieve prerequisite feature flag "' + prereq.key + '"'),
        };
      } else {
        const { err, detail } = evalInternal(prereqFlag, user, featureStore, events, eventFactory);
        // If there was an error, the value is null, the variation index is out of range,
        // or the value does not match the indexed variation the prerequisite is not satisfied
        events.push(eventFactory.newEvalEvent(prereqFlag, user, detail, null, flag));
        if (err) {
          errInfo = { key: prereq.key, err: err };
        } else if (!prereqFlag.on || detail.variationIndex !== prereq.variation) {
          // Note that if the prerequisite flag is off, we don't consider it a match no matter what its
          // off variation was. But we still evaluate it and generate an event.
          errInfo = { key: prereq.key };
        }
      }

      if (errInfo) {
        return {
          err: errInfo.err,
          reason: {
            kind: 'PREREQUISITE_FAILED',
            prerequisiteKey: errInfo.key,
          }
        };
      }
    }
  }
  return { err: null, detail: null };
}

// Callback receives (err, detail)
function evalRules(flag, user, featureStore) {
  // Check target matches
  for (let i = 0; i < (flag.targets || []).length; i++) {
    const target = flag.targets[i];

    if (!target.values) {
      continue;
    }

    for (let j = 0; j < target.values.length; j++) {
      if (user.key === target.values[j]) {
        return getVariation(flag, target.variation, { kind: 'TARGET_MATCH' });
      }
    }
  }

  for (const rule of (flag.rules || [])) {
    const matched = ruleMatchUser(rule, user, featureStore);
    if (matched) {
      const reason = { kind: 'RULE_MATCH', ruleId: rule.id };
      for (let i = 0; i < flag.rules.length; i++) {
        if (flag.rules[i].id === rule.id) {
          reason.ruleIndex = i;
          break;
        }
      }
      return getResultForVariationOrRollout(rule, user, flag, reason);
    }
  }
  // no rule matched; check the fallthrough
  return getResultForVariationOrRollout(flag.fallthrough, user, flag, { kind: 'FALLTHROUGH' });
}

function ruleMatchUser(r, user, featureStore) {
  if (!r.clauses) {
    return false;
  }

  // A rule matches if all its clauses match.
  for (const clause of r.clauses) {
    const matched = clauseMatchUser(clause, user, featureStore);
    if (!matched) {
      return false;
    }
  }
  return true;
}

function clauseMatchUser(c, user, featureStore) {
  if (c.op === 'segmentMatch') {
    for (const value of c.values) {
      const segment = featureStore.get(dataKind.segments, value);
      if (segment && segmentMatchUser(segment, user)) {
        return maybeNegate(c, !!segment);
      }
    }
    return maybeNegate(c, false);
  } else {
    return clauseMatchUserNoSegments(c, user);
  }
}

function clauseMatchUserNoSegments(c, user) {
  const uValue = userValue(user, c.attribute);

  if (uValue === null || uValue === undefined) {
    return false;
  }

  const matchFn = operators.fn(c.op);

  // The user's value is an array
  if (Array === uValue.constructor) {
    for (let i = 0; i < uValue.length; i++) {
      if (matchAny(matchFn, uValue[i], c.values)) {
        return maybeNegate(c, true);
      }
    }
    return maybeNegate(c, false);
  }

  return maybeNegate(c, matchAny(matchFn, uValue, c.values));
}

function segmentMatchUser(segment, user) {
  if (user.key) {
    if ((segment.included || []).indexOf(user.key) >= 0) {
      return true;
    }
    if ((segment.excluded || []).indexOf(user.key) >= 0) {
      return false;
    }
    for (let i = 0; i < (segment.rules || []).length; i++) {
      if (segmentRuleMatchUser(segment.rules[i], user, segment.key, segment.salt)) {
        return true;
      }
    }
  }
  return false;
}

function segmentRuleMatchUser(rule, user, segmentKey, salt) {
  for (let i = 0; i < (rule.clauses || []).length; i++) {
    if (!clauseMatchUserNoSegments(rule.clauses[i], user)) {
      return false;
    }
  }

  // If the weight is absent, this rule matches
  if (rule.weight === undefined || rule.weight === null) {
    return true;
  }

  // All of the clauses are met. See if the user buckets in
  const bucket = bucketUser(user, segmentKey, rule.bucketBy || 'key', salt);
  const weight = rule.weight / 100000.0;
  return bucket < weight;
}

function maybeNegate(c, b) {
  if (c.negate) {
    return !b;
  } else {
    return b;
  }
}

function matchAny(matchFn, value, values) {
  for (let i = 0; i < values.length; i++) {
    if (matchFn(value, values[i])) {
      return true;
    }
  }

  return false;
}

function getVariation(flag, index, reason) {
  if (index === null || index === undefined || index < 0 || index >= flag.variations.length) {
    return { err: new Error('Invalid variation index in flag'), detail: errorResult('MALFORMED_FLAG') };
  } else {
    return { err: null, detail: { value: flag.variations[index], variationIndex: index, reason: reason } };
  }
}

function getOffResult(flag, reason) {
  if (flag.offVariation === null || flag.offVariation === undefined) {
    return { err: null, detail: { value: null, variationIndex: null, reason: reason } };
  } else {
    return getVariation(flag, flag.offVariation, reason);
  }
}

function getResultForVariationOrRollout(r, user, flag, reason) {
  if (!r) {
    return { err: new Error('Fallthrough variation undefined'), detail: errorResult('MALFORMED_FLAG') };
  } else {
    const index = variationForUser(r, user, flag);
    if (index === null || index === undefined) {
      return { err: new Error('Variation/rollout object with no variation or rollout'), detail: errorResult('MALFORMED_FLAG') };
    } else {
      return getVariation(flag, index, reason);
    }
  }
}

function errorResult(errorKind) {
  return { value: null, variationIndex: null, reason: { kind: 'ERROR', errorKind: errorKind } };
}

// Given a variation or rollout 'r', select
// the variation for the given user
function variationForUser(r, user, flag) {
  if (r.variation !== null && r.variation !== undefined) {
    // This represets a fixed variation; return it
    return r.variation;
  }
  const rollout = r.rollout;
  if (rollout) {
    const variations = rollout.variations;
    if (variations && variations.length > 0) {
      // This represents a percentage rollout. Assume
      // we're rolling out by key
      const bucketBy = rollout.bucketBy || 'key';
      const bucket = bucketUser(user, flag.key, bucketBy, flag.salt);
      let sum = 0;
      for (let i = 0; i < variations.length; i++) {
        const variate = variations[i];
        sum += variate.weight / 100000.0;
        if (bucket < sum) {
          return variate.variation;
        }
      }

      // The user's bucket value was greater than or equal to the end of the last bucket. This could happen due
      // to a rounding error, or due to the fact that we are scaling to 100000 rather than 99999, or the flag
      // data could contain buckets that don't actually add up to 100000. Rather than returning an error in
      // this case (or changing the scaling, which would potentially change the results for *all* users), we
      // will simply put the user in the last bucket.
      return variations[variations.length - 1].variation;
    }
  }

  return null;
}

// Fetch an attribute value from a user object. Automatically
// navigates into the custom array when necessary
function userValue(user, attr) {
  if (builtins.indexOf(attr) >= 0 && Object.hasOwnProperty.call(user, attr)) {
    return user[attr];
  }
  if (user.custom && Object.hasOwnProperty.call(user.custom, attr)) {
    return user.custom[attr];
  }
  return null;
}

// Compute a percentile for a user
function bucketUser(user, key, attr, salt) {
  let idHash = bucketableStringValue(userValue(user, attr));

  if (idHash === null) {
    return 0;
  }

  if (user.secondary) {
    idHash += '.' + user.secondary;
  }

  const hashKey = util.format('%s.%s.%s', key, salt, idHash);
  const hashVal = parseInt(sha1Hex(hashKey).substring(0, 15), 16);

  return hashVal / 0xfffffffffffffff;
}

function bucketableStringValue(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (Number.isInteger(value)) {
    return '' + value;
  }
  return null;
}

function sha1Hex(input) {
  const hash = crypto.createHash('sha1');
  hash.update(input);
  return hash.digest('hex');
}

module.exports = { evaluate: evaluate, bucketUser: bucketUser };
