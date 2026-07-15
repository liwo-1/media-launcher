const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./data-dir');
const { writeJsonAtomic } = require('./atomic-json');

const STORE_PATH = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  mediaProvider: 'plex',
  plexUrl: '',
  jellyfinUrl: '',
  playerAgentUrl: '',
  playerAgentSecret: '',
  playerAgentInstanceId: '',
  playerAgentPairingConfirmed: null,
  adminPinHash: '',
  pathMap: [],
  defaultPlaybackTargetId: '',
  alwaysAskPlaybackTarget: true,
};

class SettingsStoreError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'SettingsStoreError';
  }
}

function readSettings() {
  let text;
  try {
    text = fs.readFileSync(STORE_PATH, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...DEFAULTS };
    throw new SettingsStoreError('The settings file could not be read.', error);
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('settings must be a JSON object');
    }
    if (
      Object.hasOwn(parsed, 'adminPinHash') &&
      typeof parsed.adminPinHash !== 'string'
    ) {
      throw new TypeError('adminPinHash must be a string');
    }
    const settings = { ...DEFAULTS, ...parsed };
    settings.mediaProvider = settings.mediaProvider === 'jellyfin' ? 'jellyfin' : 'plex';
    return settings;
  } catch (error) {
    throw new SettingsStoreError('The settings file is not valid JSON.', error);
  }
}

function writeSettings(patch) {
  const settings = { ...readSettings(), ...patch };
  writeJsonAtomic(STORE_PATH, settings);
  return settings;
}

module.exports = { DEFAULTS, SettingsStoreError, readSettings, writeSettings };
