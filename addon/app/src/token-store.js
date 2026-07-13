const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// /data is Home Assistant's persistent per-add-on storage dir (always present in the real
// add-on, survives restarts/updates). Falls back to a local folder for `npm start` dev.
const DATA_DIR =
  process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'local-data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

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
