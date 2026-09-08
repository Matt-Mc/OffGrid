const test = require('node:test');
const assert = require('node:assert/strict');
const { maximumMacOSVersion } = require('../scripts/sign-mac.cjs');

test('macOS app minimum follows the higher Electron or bundled runtime requirement', () => {
  assert.equal(maximumMacOSVersion('11.0.0', '26.0'), '26.0');
  assert.equal(maximumMacOSVersion('26.1', '26.0'), '26.1');
  assert.equal(maximumMacOSVersion('10.9', '10.15'), '10.15');
  assert.equal(maximumMacOSVersion('15.0', '15.0.1'), '15.0.1');
  assert.equal(maximumMacOSVersion('15.0.0', '15.0'), '15.0.0');
});

test('macOS minimum version validation rejects missing or nonnumeric runtime data', () => {
  for (const value of [undefined, null, 26, '', '26-beta', '26.0\nAdd :Unwanted string yes', '26.0.1.2', '9007199254740992']) {
    assert.throws(() => maximumMacOSVersion('11.0', value), /Invalid minimum macOS version/);
  }
  assert.throws(() => maximumMacOSVersion(), /required/);
});
