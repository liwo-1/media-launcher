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
    const normalizedSource = String(sourcePath).replace(/\\/g, '/');
    const normalizedFrom = String(from).replace(/\\/g, '/').replace(/\/+$/, '');
    const windowsStyleSource = /^[a-z]:[\\/]/i.test(String(from)) ||
      String(from).startsWith('\\\\');
    const comparableSource = windowsStyleSource ? normalizedSource.toLowerCase() : normalizedSource;
    const comparableFrom = windowsStyleSource ? normalizedFrom.toLowerCase() : normalizedFrom;
    const isBoundaryMatch =
      comparableSource === comparableFrom ||
      (comparableSource.startsWith(comparableFrom) &&
        comparableSource.charAt(comparableFrom.length) === '/');
    if (normalizedFrom && isBoundaryMatch) {
      const normalizedTo = String(to).replace(/[\\/]+$/, '');
      if (!normalizedTo) continue;
      const mapped = normalizedTo + normalizedSource.slice(normalizedFrom.length);
      return agent?.platform === 'linux'
        ? mapped.replace(/\\/g, '/')
        : mapped.replace(/\//g, '\\');
    }
  }
  throw new Error(
    rules.length === 0
      ? `No path mappings are configured for ${agent?.name || 'this player'} yet - set them on the Settings page.`
      : 'No path mapping rule matches this media server path - update it on the Settings page.'
  );
}

function toWindowsPath(sourcePath) {
  return resolveMediaPath(sourcePath, { platform: 'windows', pathMap: legacyRules() });
}

module.exports = { resolveMediaPath, toWindowsPath };
