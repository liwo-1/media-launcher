const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = path.join(os.tmpdir(), `media-launcher-admin-auth-test-${process.pid}`);
const { hashPin, verifyPin, requireAdminPin } = require('../src/admin-auth');
const { writeSettings } = require('../src/settings-store');

test('hashes and verifies an admin PIN without storing the plaintext', () => {
  const encoded = hashPin('123456');
  assert.equal(encoded.includes('123456'), false);
  assert.equal(verifyPin('123456', encoded), true);
  assert.equal(verifyPin('123457', encoded), false);
});

test('admin middleware allows bootstrap, then fails closed after a PIN is configured', () => {
  writeSettings({ adminPinHash: '' });
  let nextCalled = false;
  requireAdminPin({ headers: {} }, {}, () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  writeSettings({ adminPinHash: hashPin('9876') });
  const result = {};
  const response = {
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; return this; },
  };
  nextCalled = false;
  requireAdminPin({ headers: { 'x-admin-pin': 'wrong' } }, response, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(result.status, 401);

  requireAdminPin({ headers: { 'x-admin-pin': '9876' } }, response, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});
