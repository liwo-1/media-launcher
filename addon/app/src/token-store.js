const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./data-dir');
const { writeJsonAtomic } = require('./atomic-json');

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

function getStoredToken() {
  return readStore().token || null;
}

function setStoredToken(token) {
  writeStore({ token });
}

module.exports = { getClientId, getStoredToken, setStoredToken };
