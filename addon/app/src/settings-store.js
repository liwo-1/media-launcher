const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./data-dir');

const STORE_PATH = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = { plexUrl: '', playerAgentUrl: '', pathMap: [] };

function readSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeSettings(patch) {
  const settings = { ...readSettings(), ...patch };
  fs.writeFileSync(STORE_PATH, JSON.stringify(settings, null, 2));
  return settings;
}

module.exports = { readSettings, writeSettings };
