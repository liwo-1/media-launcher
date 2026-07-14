const fs = require('fs');
const path = require('path');

// /data is Home Assistant's persistent per-add-on storage dir (always present in the real
// add-on, survives restarts/updates). Falls back to a local folder for `npm start` dev.
const DATA_DIR =
  process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'local-data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

module.exports = { DATA_DIR };
