const { readSettings } = require('./settings-store');

// Path mapping rules: array of { from, to } pairs, edited on the Settings page and persisted to
// /data. Both sides use forward slashes only - the final Windows path is produced by converting
// all slashes to backslashes as the very last step, e.g. for a Synology NAS running Plex:
// [{ "from": "/volume1/video/Movies", "to": "//nas/Movies" },
//  { "from": "/volume1/video/TV",     "to": "//nas/TV" }]
function getRules() {
  return process.env.PATH_MAP ? JSON.parse(process.env.PATH_MAP) : readSettings().pathMap;
}

function toWindowsPath(plexPath) {
  const rules = getRules();
  for (const { from, to } of rules) {
    if (plexPath.startsWith(from)) {
      const rest = plexPath.slice(from.length);
      return (to + rest).replace(/\//g, '\\');
    }
  }
  throw new Error(
    rules.length === 0
      ? 'No path mappings are configured yet - set them on the Settings page.'
      : `No path mapping rule matches: ${plexPath}`
  );
}

module.exports = { toWindowsPath };
