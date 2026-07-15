const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./data-dir');
const { writeJsonAtomic } = require('./atomic-json');
const { normalizeServerUrl } = require('./server-url');

const STORE_PATH = path.join(DATA_DIR, 'plex-auth.json');

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeStore(patch) {
  const store = { ...readStore(), ...patch };
  writeJsonAtomic(STORE_PATH, store);
}

function getClientId() {
  const store = readStore();
  if (store.clientId) return store.clientId;
  const clientId = crypto.randomUUID();
  writeStore({ clientId });
  return clientId;
}

function normalizedScope(serverUrl) {
  if (typeof serverUrl !== 'string' || !serverUrl.trim()) return '';
  try {
    return normalizeServerUrl(serverUrl, { required: true, field: 'Plex server URL' });
  } catch {
    return '';
  }
}

function getStoredToken(serverUrl) {
  const requestedScope = normalizedScope(serverUrl);
  const store = readStore();
  const storedScope = normalizedScope(store.serverUrl);
  if (typeof store.token === 'string' && store.token && !storedScope) {
    // Older beta builds saved a reusable account token without its server identity. It cannot be
    // safely adopted after upgrade, so remove the local secret while preserving the stable client
    // id. The user can then create a newly scoped token through the normal linking flow.
    writeStore({
      token: null,
      serverUrl: null,
      legacyUnscopedTokenCleared: true,
    });
    return null;
  }
  if (!requestedScope) return null;
  if (!storedScope || storedScope !== requestedScope) return null;
  return typeof store.token === 'string' && store.token ? store.token : null;
}

function setStoredToken(token, serverUrl) {
  if (!token) {
    writeStore({ token: null, serverUrl: null });
    return;
  }
  const scope = normalizeServerUrl(serverUrl, { required: true, field: 'Plex server URL' });
  writeStore({ token, serverUrl: scope });
}

module.exports = { getClientId, getStoredToken, setStoredToken };
