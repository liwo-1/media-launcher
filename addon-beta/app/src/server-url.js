function normalizeServerUrl(value, { required = false, field = 'Server URL' } = {}) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new Error(`${field} is required`);
    return '';
  }
  if (trimmed.length > 2048) throw new Error(`${field} is too long`);

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${field} must be an http:// or https:// URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${field} must be an http:// or https:// URL`);
  }
  if (parsed.username || parsed.password) throw new Error(`${field} cannot contain credentials`);
  if (parsed.search || parsed.hash) throw new Error(`${field} cannot contain a query or fragment`);

  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${path === '/' ? '' : path}`;
}

function joinServerPath(serverUrl, requestPath) {
  const base = normalizeServerUrl(serverUrl, { required: true });
  if (typeof requestPath !== 'string' || !requestPath.startsWith('/')) {
    throw new Error('Provider request paths must start with /');
  }
  return `${base}${requestPath}`;
}

function sameServerUrl(left, right) {
  try {
    return normalizeServerUrl(left, { required: true }) === normalizeServerUrl(right, { required: true });
  } catch {
    return false;
  }
}

module.exports = { joinServerPath, normalizeServerUrl, sameServerUrl };
