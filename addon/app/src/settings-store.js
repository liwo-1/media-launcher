const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./data-dir');
const { writeJsonAtomic } = require('./atomic-json');

const STORE_PATH = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  plexUrl: '',
  playerAgentUrl: '',
  playerAgentSecret: '',
  playerAgentInstanceId: '',
  adminPinHash: '',
  pathMap: [],
};

function readSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeSettings(patch) {
  const settings = { ...readSettings(), ...patch };
  writeJsonAtomic(STORE_PATH, settings);
  return settings;
}

module.exports = { readSettings, writeSettings };
