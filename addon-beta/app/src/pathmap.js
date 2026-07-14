const { readSettings } = require('./settings-store');

function legacyRules() {
  return process.env.PATH_MAP ? JSON.parse(process.env.PATH_MAP) : readSettings().pathMap;
}

function getRules(agent) {
  return agent && Array.isArray(agent.pathMap) ? agent.pathMap : legacyRules();
}

function resolveMediaPath(sourcePath, agent) {
  const rules = getRules(agent);
  for (const { from, to } of rules) {
    const normalizedFrom = from.endsWith('/') ? from.slice(0, -1) : from;
    const isBoundaryMatch =
      sourcePath === normalizedFrom ||
      (sourcePath.startsWith(normalizedFrom) && sourcePath.charAt(normalizedFrom.length) === '/');
    if (normalizedFrom && isBoundaryMatch) {
      const mapped = to + sourcePath.slice(normalizedFrom.length);
      return agent?.platform === 'linux'
        ? mapped.replace(/\\/g, '/')
        : mapped.replace(/\//g, '\\');
    }
  }
  throw new Error(
    rules.length === 0
      ? `No path mappings are configured for ${agent?.name || 'this player'} yet - set them on the Settings page.`
      : `No path mapping rule matches: ${sourcePath}`
  );
}

function toWindowsPath(sourcePath) {
  return resolveMediaPath(sourcePath, { platform: 'windows', pathMap: legacyRules() });
}

module.exports = { resolveMediaPath, toWindowsPath };
