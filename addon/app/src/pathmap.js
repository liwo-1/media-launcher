// PATH_MAP env var: JSON array of { from, to } pairs. Both sides use forward slashes only -
// deliberately, so nothing here ever needs a backslash to survive YAML -> options.json -> jq ->
// env var -> JSON.parse intact (that chain mangling literal backslashes is exactly the kind of bug
// this sidesteps). The final Windows path is produced by converting all slashes to backslashes as
// the very last step, e.g. for a Synology NAS running Plex:
// [{ "from": "/volume1/video/Movies", "to": "//nas/Movies" },
//  { "from": "/volume1/video/TV",     "to": "//nas/TV" }]
const rules = JSON.parse(process.env.PATH_MAP || '[]');

if (rules.length === 0) {
  console.warn('Warning: PATH_MAP is empty - no Plex path will resolve to a Windows path.');
}

function toWindowsPath(plexPath) {
  for (const { from, to } of rules) {
    if (plexPath.startsWith(from)) {
      const rest = plexPath.slice(from.length);
      return (to + rest).replace(/\//g, '\\');
    }
  }
  throw new Error(`No path mapping rule matches: ${plexPath}`);
}

module.exports = { toWindowsPath };
