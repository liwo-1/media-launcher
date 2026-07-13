const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./data-dir');

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
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function getClientId() {
  const store = readStore();
  if (store.clientId) return store.clientId;
  const clientId = crypto.randomUUID();
  writeStore({ clientId });
  return clientId;
}

function getStoredToken() {
  return readStore().token || null;
}

function setStoredToken(token) {
  writeStore({ token });
}

module.exports = { getClientId, getStoredToken, setStoredToken };

