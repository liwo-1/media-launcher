'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dataDir = path.join(os.tmpdir(), `media-launcher-token-store-test-${process.pid}`);
process.env.DATA_DIR = dataDir;

const { getStoredToken, setStoredToken } = require('../src/token-store');

test('binds a stored Plex token to one normalized server URL', (t) => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  setStoredToken('private-token', 'http://plex-a.local:32400/');

  assert.equal(getStoredToken('http://plex-a.local:32400'), 'private-token');
  assert.equal(getStoredToken('http://plex-b.local:32400'), null);
  assert.equal(getStoredToken(), null);
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'plex-auth.json'), 'utf8'));
  assert.equal(persisted.serverUrl, 'http://plex-a.local:32400');
  assert.equal(persisted.token, 'private-token');
});

test('fails closed for an unscoped legacy token and clears both token and scope', (t) => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(dataDir, 'plex-auth.json'),
    JSON.stringify({ clientId: 'stable-client-id', token: 'legacy-token' })
  );
  assert.equal(getStoredToken('http://plex.local:32400'), null);
  const migrated = JSON.parse(fs.readFileSync(path.join(dataDir, 'plex-auth.json'), 'utf8'));
  assert.equal(migrated.clientId, 'stable-client-id');
  assert.equal(migrated.token, null);
  assert.equal(migrated.legacyUnscopedTokenCleared, true);

  setStoredToken(null);
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'plex-auth.json'), 'utf8'));
  assert.equal(persisted.token, null);
  assert.equal(persisted.serverUrl, null);
});
