const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dataDir = path.join(os.tmpdir(), `media-launcher-jellyfin-auth-test-${process.pid}`);
process.env.DATA_DIR = dataDir;
delete process.env.JELLYFIN_ACCESS_TOKEN;
delete process.env.JELLYFIN_URL;
delete process.env.JELLYFIN_USER_ID;
delete process.env.JELLYFIN_DEVICE_ID;

const authStore = require('../src/jellyfin-auth-store');

test.beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  delete process.env.JELLYFIN_ACCESS_TOKEN;
  delete process.env.JELLYFIN_URL;
  delete process.env.JELLYFIN_USER_ID;
  delete process.env.JELLYFIN_DEVICE_ID;
});

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('persists one stable device id without creating credentials', () => {
  const first = authStore.getDeviceId();
  const second = authStore.getDeviceId();

  assert.equal(second, first);
  assert.match(first, /^[0-9a-f-]{36}$/i);
  assert.equal(authStore.publicCredentialState('http://jellyfin.test:8096').linked, false);
});

test('stores a user token only for the authenticated server and never persists a password', () => {
  authStore.saveCredentials({
    serverUrl: 'http://jellyfin.test:8096/',
    accessToken: 'token-1',
    userId: 'user-1',
    username: 'Movie User',
    serverId: 'server-1',
    serverName: 'Home Jellyfin',
    isAdministrator: true,
    password: 'must-not-be-written',
  });

  const credentials = authStore.getCredentialSnapshot('http://jellyfin.test:8096');
  assert.equal(credentials.accessToken, 'token-1');
  assert.equal(credentials.userId, 'user-1');
  assert.equal(credentials.isAdministrator, true);
  assert.equal(
    authStore.getCredentialSnapshot('http://other-jellyfin.test:8096').accessToken,
    ''
  );
  assert.doesNotMatch(fs.readFileSync(authStore._test.STORE_PATH, 'utf8'), /must-not-be-written/);
});

test('unlink keeps the device identity while deleting stored credentials', () => {
  const deviceId = authStore.getDeviceId();
  authStore.saveCredentials({
    serverUrl: 'http://jellyfin.test:8096',
    accessToken: 'token-1',
    userId: 'user-1',
  });

  authStore.clearCredentials();

  assert.equal(authStore.getDeviceId(), deviceId);
  assert.equal(authStore.getCredentialSnapshot('http://jellyfin.test:8096').accessToken, '');
});

test('environment credentials are scoped to JELLYFIN_URL and cannot be unlinked in the UI', () => {
  process.env.JELLYFIN_ACCESS_TOKEN = 'environment-token';
  process.env.JELLYFIN_USER_ID = 'environment-user';
  process.env.JELLYFIN_URL = 'https://jellyfin.example.test/base';

  assert.equal(
    authStore.getCredentialSnapshot('https://jellyfin.example.test/base/').accessToken,
    'environment-token'
  );
  assert.equal(
    authStore.getCredentialSnapshot('https://jellyfin.example.test/other').accessToken,
    ''
  );
  assert.throws(() => authStore.clearCredentials(), /managed by environment variables/);
});

test('whitespace-only Jellyfin environment credentials do not disable unlink', () => {
  process.env.JELLYFIN_ACCESS_TOKEN = '   ';

  assert.doesNotThrow(() => authStore.clearCredentials());
});

test('preserves a corrupt credential store before an explicit replacement', () => {
  fs.writeFileSync(authStore._test.STORE_PATH, '{broken', 'utf8');

  authStore.saveCredentials({
    serverUrl: 'http://jellyfin.test:8096',
    accessToken: 'replacement-token',
    userId: 'replacement-user',
  });

  const quarantined = fs.readdirSync(dataDir).filter((name) => name.includes('.corrupt-'));
  assert.equal(quarantined.length, 1);
  assert.equal(
    authStore.getCredentialSnapshot('http://jellyfin.test:8096').accessToken,
    'replacement-token'
  );
});
