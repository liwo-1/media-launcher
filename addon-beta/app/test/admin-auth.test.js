const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = path.join(os.tmpdir(), `media-launcher-admin-auth-test-${process.pid}`);
const { hashPin, verifyPin, requireAdminPin, _test } = require('../src/admin-auth');
const { writeSettings } = require('../src/settings-store');

test('hashes and verifies an admin PIN without storing the plaintext', () => {
  const encoded = hashPin('123456');
  assert.equal(encoded.includes('123456'), false);
  assert.equal(verifyPin('123456', encoded), true);
  assert.equal(verifyPin('123457', encoded), false);
});

test('admin middleware allows bootstrap, then fails closed after a PIN is configured', () => {
  _test.failures.clear();
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

test('bounds expensive incorrect PIN checks per network source', () => {
  _test.failures.clear();
  writeSettings({ adminPinHash: hashPin('2468') });
  let result;
  const response = {
    status(code) { result.status = code; return this; },
    set(name, value) { result.headers[name] = value; return this; },
    json(body) { result.body = body; return this; },
  };
  const request = { ip: '192.0.2.10', headers: { 'x-admin-pin': 'wrong' } };
  for (let attempt = 0; attempt < _test.MAX_FAILURES; attempt += 1) {
    result = { headers: {} };
    requireAdminPin(request, response, () => assert.fail('wrong PIN must not pass'));
    assert.equal(result.status, 401);
  }

  result = { headers: {} };
  requireAdminPin(request, response, () => assert.fail('throttled request must not pass'));
  assert.equal(result.status, 429);
  assert.equal(result.body.adminPinRequired, true);
  assert.match(result.headers['Retry-After'], /^\d+$/);

  _test.failures.get('192.0.2.10').startedAt -= _test.FAILURE_WINDOW_MS;
  let nextCalled = false;
  result = { headers: {} };
  requireAdminPin(
    { ...request, headers: { 'x-admin-pin': '2468' } },
    response,
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, true);
  assert.equal(_test.failures.has('192.0.2.10'), false);
});
