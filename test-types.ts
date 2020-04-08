
// This file exists only so that we can run the TypeScript compiler in the CI build
// to validate our index.d.ts file. This code will not actually be run - the point is
// just to verify that the type declarations exist and are correct so a TypeScript
// developer can use all of the SDK features.

import * as ld from 'launchdarkly-node-server-sdk';

var logger: ld.LDLogger = {
  error: (...args) => { },
  warn: (...args) => { },
  info: (...args) => { },
  debug: (...args) => { }
};
var emptyOptions: ld.LDOptions = {};
var allOptions: ld.LDOptions = {
  baseUri: '',
  eventsUri: '',
  streamUri: '',
  stream: true,
  streamInitialReconnectDelay: 1.5,
  sendEvents: true,
  allAttributesPrivate: true,
  privateAttributeNames: [ 'x' ],
  capacity: 100,
  flushInterval: 1,
  userKeysCapacity: 100,
  userKeysFlushInterval: 1,
  pollInterval: 5,
  timeout: 1,
  logger: logger,
  tlsParams: {
    ca: 'x',
    cert: 'y',
    key: 'z'
  },
  diagnosticOptOut: true,
  diagnosticRecordingInterval: 100,
  wrapperName: 'x',
  wrapperVersion: 'y'
};
var userWithKeyOnly: ld.LDUser = { key: 'user' };
var user: ld.LDUser = {
  key: 'user',
  name: 'name',
  secondary: 'otherkey',
  firstName: 'first',
  lastName: 'last',
  email: 'test@example.com',
  avatar: 'http://avatar.url',
  ip: '1.1.1.1',
  country: 'us',
  anonymous: true,
  custom: {
    'a': 's',
    'b': true,
    'c': 3,
    'd': [ 'x', 'y' ],
    'e': [ true, false ],
    'f': [ 1, 2 ]
  },
  privateAttributeNames: [ 'name', 'email' ]
};
var client: ld.LDClient = ld.init('sdk-key', allOptions);

client.identify(user);
client.track('key', user);
client.track('key', user, { ok: 1 });
client.track('key', user, null, 1.5);

// evaluation methods with callbacks
var value: ld.LDFlagValue = client.variation('key', user, false);
var value: ld.LDFlagValue = client.variation('key', user, 2);
var value: ld.LDFlagValue = client.variation('key', user, 'default');
const detail = client.variationDetail('key', user, 'default');
var detailValue: ld.LDFlagValue = detail.value;
var detailIndex: number | undefined = detail.variationIndex;
var detailReason: ld.LDEvaluationReason = detail.reason;
var flagSet = client.allFlags(user);
var flagSetValue: ld.LDFlagValue = flagSet['key'];
