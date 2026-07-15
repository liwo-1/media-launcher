const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./data-dir');
const { writeJsonAtomic } = require('./atomic-json');
const { normalizeServerUrl, sameServerUrl } = require('./server-url');

const STORE_PATH = path.join(DATA_DIR, 'jellyfin-auth.json');
const DEFAULTS = Object.freeze({
  deviceId: '',
  serverUrl: '',
  accessToken: '',
  userId: '',
  serverId: '',
  serverName: '',
  username: '',
  isAdministrator: false,
});

function cleanString(value, maxLength = 512) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeStore(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    deviceId: cleanString(source.deviceId, 128),
    serverUrl: cleanString(source.serverUrl, 2048),
    accessToken: cleanString(source.accessToken, 4096),
    userId: cleanString(source.userId, 256),
    serverId: cleanString(source.serverId, 256),
    serverName: cleanString(source.serverName, 256),
    username: cleanString(source.username, 256),
    isAdministrator: source.isAdministrator === true,
  };
}

function loadStore() {
  try {
    return {
      value: normalizeStore(JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))),
      corrupt: false,
    };
  } catch (err) {
    if (err.code === 'ENOENT') return { value: { ...DEFAULTS }, corrupt: false };
    console.error(`Could not read Jellyfin credentials: ${err.message}`);
    return { value: { ...DEFAULTS }, corrupt: true };
  }
}

function preserveCorruptStore() {
  if (!fs.existsSync(STORE_PATH)) return;
  const quarantine = `${STORE_PATH}.corrupt-${Date.now()}`;
  fs.renameSync(STORE_PATH, quarantine);
}

function writeStore(value) {
  const current = loadStore();
  if (current.corrupt) preserveCorruptStore();
  const normalized = normalizeStore(value);
  writeJsonAtomic(STORE_PATH, normalized);
  return normalized;
}

function getDeviceId() {
  const environmentId = cleanString(process.env.JELLYFIN_DEVICE_ID, 128);
  if (environmentId) return environmentId;
  const current = loadStore();
  if (current.value.deviceId) return current.value.deviceId;
  const deviceId = crypto.randomUUID();
  writeStore({ ...current.value, deviceId });
  return deviceId;
}

function saveCredentials(credentials) {
  const serverUrl = normalizeServerUrl(credentials?.serverUrl || '', {
    required: true,
    field: 'Jellyfin server URL',
  });
  const accessToken = cleanString(credentials?.accessToken, 4096);
  const userId = cleanString(credentials?.userId, 256);
  if (!accessToken || !userId) throw new Error('Jellyfin returned incomplete credentials');
  const current = loadStore().value;
  return writeStore({
    ...current,
    deviceId: current.deviceId || getDeviceId(),
    serverUrl,
    accessToken,
    userId,
    serverId: cleanString(credentials.serverId, 256),
    serverName: cleanString(credentials.serverName, 256),
    username: cleanString(credentials.username, 256),
    isAdministrator: credentials.isAdministrator === true,
  });
}

function clearCredentials() {
  if (cleanString(process.env.JELLYFIN_ACCESS_TOKEN, 4096)) {
    const err = new Error('Jellyfin authentication is managed by environment variables.');
    err.status = 409;
    throw err;
  }
  const current = loadStore().value;
  return writeStore({
    ...current,
    serverUrl: '',
    accessToken: '',
    userId: '',
    serverId: '',
    serverName: '',
    username: '',
    isAdministrator: false,
  });
}

function getCredentialSnapshot(serverUrl) {
  const normalizedUrl = normalizeServerUrl(serverUrl || '', {
    required: false,
    field: 'Jellyfin server URL',
  });
  const environmentToken = cleanString(process.env.JELLYFIN_ACCESS_TOKEN, 4096);
  if (environmentToken) {
    const environmentUrl = normalizeServerUrl(process.env.JELLYFIN_URL || '', {
      required: false,
      field: 'JELLYFIN_URL',
    });
    const scoped = normalizedUrl && environmentUrl && sameServerUrl(normalizedUrl, environmentUrl);
    return {
      accessToken: scoped ? environmentToken : '',
      userId: scoped ? cleanString(process.env.JELLYFIN_USER_ID, 256) : '',
      deviceId: getDeviceId(),
      serverId: '',
      serverName: '',
      username: cleanString(process.env.JELLYFIN_USERNAME, 256),
      isAdministrator: process.env.JELLYFIN_IS_ADMIN === 'true',
      environmentManaged: true,
    };
  }

  const stored = loadStore().value;
  const scoped = normalizedUrl && stored.serverUrl && sameServerUrl(normalizedUrl, stored.serverUrl);
  return {
    accessToken: scoped ? stored.accessToken : '',
    userId: scoped ? stored.userId : '',
    deviceId: getDeviceId(),
    serverId: scoped ? stored.serverId : '',
    serverName: scoped ? stored.serverName : '',
    username: scoped ? stored.username : '',
    isAdministrator: scoped && stored.isAdministrator,
    environmentManaged: false,
  };
}

function publicCredentialState(serverUrl) {
  const credentials = getCredentialSnapshot(serverUrl);
  return {
    linked: Boolean(credentials.accessToken && credentials.userId),
    accountDisplayName: credentials.username,
    serverName: credentials.serverName,
    environmentManaged: credentials.environmentManaged,
    isAdministrator: credentials.isAdministrator,
  };
}

module.exports = {
  clearCredentials,
  getCredentialSnapshot,
  getDeviceId,
  publicCredentialState,
  saveCredentials,
  _test: { STORE_PATH, loadStore },
};
