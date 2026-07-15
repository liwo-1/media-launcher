const { getStoredToken } = require('./token-store');
const { readSettings } = require('./settings-store');
const { joinServerPath, normalizeServerUrl } = require('./server-url');

let runtimeCredential = null;

// Kept for legacy tests and callers during the beta transition. Even an in-memory credential is
// scoped to the exact configured Plex URL and cannot follow a later URL change.
function setToken(token, serverUrl = getPlexUrl()) {
  runtimeCredential = token
    ? { token, serverUrl: normalizeServerUrl(serverUrl, { required: true, field: 'Plex server URL' }) }
    : null;
}

function hasToken() {
  const plexUrl = getPlexUrl();
  return Boolean(plexUrl && tokenForUrl(plexUrl));
}

function getPlexUrl() {
  return process.env.PLEX_URL || readSettings().plexUrl || null;
}

function tokenForUrl(plexUrl) {
  let normalizedUrl;
  try {
    normalizedUrl = normalizeServerUrl(plexUrl, { required: true, field: 'Plex server URL' });
  } catch {
    return null;
  }
  const environmentToken = typeof process.env.PLEX_TOKEN === 'string'
    ? process.env.PLEX_TOKEN.trim()
    : '';
  const environmentUrl = typeof process.env.PLEX_URL === 'string'
    ? process.env.PLEX_URL.trim()
    : '';
  if (environmentToken) {
    if (!environmentUrl) return null;
    try {
      return normalizeServerUrl(environmentUrl, { required: true, field: 'Plex server URL' }) === normalizedUrl
        ? environmentToken
        : null;
    } catch {
      return null;
    }
  }
  if (runtimeCredential?.serverUrl === normalizedUrl) return runtimeCredential.token;
  return getStoredToken(normalizedUrl);
}

function encodeKey(value, label = 'Plex item id') {
  const key = value === undefined || value === null ? '' : String(value);
  if (!key || key.length > 256 || /[\u0000-\u001f\u007f]/.test(key)) {
    const err = new Error(`${label} is invalid.`);
    err.status = 400;
    throw err;
  }
  return encodeURIComponent(key);
}

async function plexFetch(path, { binary = false, parseJson = true } = {}) {
  const plexUrl = getPlexUrl();
  if (!plexUrl) {
    const err = new Error('Plex server URL is not configured yet - set it on the Settings page.');
    err.status = 400;
    throw err;
  }
  const token = tokenForUrl(plexUrl);
  if (!token) {
    const err = new Error('Plex account is not linked yet.');
    err.status = 401;
    throw err;
  }
  const url = joinServerPath(plexUrl, path);
  const response = await fetch(url, {
    headers: {
      'X-Plex-Token': token,
      Accept: binary ? 'image/*' : 'application/json',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(binary ? 30000 : 15000),
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error('Plex server URL returned a redirect; configure its final URL.');
  }
  if (!response.ok) {
    throw new Error(`Plex request failed (${response.status}): ${path}`);
  }

  if (binary) return response;
  if (!parseJson) return null;
  return response.json();
}

async function getSections() {
  const data = await plexFetch('/library/sections');
  return data.MediaContainer.Directory || [];
}

// Each library section reports its own root folder path(s) (a library can span more than one
// folder) - surfacing these lets the Settings page auto-fill the "from" side of path mappings
// instead of making the user go dig them out of the Plex web UI by hand.
async function getLibraryPaths() {
  const sections = await getSections();
  const paths = [];
  for (const section of sections) {
    for (const location of section.Location || []) {
      paths.push({ path: location.path, library: section.title });
    }
  }
  return paths;
}

async function getItems(sectionKey) {
  const data = await plexFetch(`/library/sections/${encodeKey(sectionKey, 'Plex library id')}/all`);
  return data.MediaContainer.Metadata || [];
}

async function getRecentlyAdded(sectionKey) {
  const data = await plexFetch(
    `/library/sections/${encodeKey(sectionKey, 'Plex library id')}/recentlyAdded`
  );
  return data.MediaContainer.Metadata || [];
}

async function getChildren(ratingKey) {
  const data = await plexFetch(`/library/metadata/${encodeKey(ratingKey)}/children`);
  return data.MediaContainer.Metadata || [];
}

function getSeasons(showRatingKey) {
  return getChildren(showRatingKey);
}

function getEpisodes(seasonRatingKey) {
  return getChildren(seasonRatingKey);
}

async function getItemFull(ratingKey) {
  const data = await plexFetch(`/library/metadata/${encodeKey(ratingKey)}`);
  return data.MediaContainer.Metadata[0];
}

function getImage(relativePath) {
  return plexFetch(relativePath, { binary: true });
}

async function getOnDeck() {
  const data = await plexFetch('/library/onDeck');
  return data.MediaContainer.Metadata || [];
}

async function getRelated(ratingKey) {
  const data = await plexFetch(`/library/metadata/${encodeKey(ratingKey)}/related`);
  const hub = (data.MediaContainer.Hub || [])[0];
  return (hub && hub.Metadata) || [];
}

function markWatched(ratingKey) {
  const key = decodeURIComponent(encodeKey(ratingKey));
  const params = new URLSearchParams({ key, identifier: 'com.plexapp.plugins.library' });
  return plexFetch(`/:/scrobble?${params}`, { parseJson: false });
}

function markUnwatched(ratingKey) {
  const key = decodeURIComponent(encodeKey(ratingKey));
  const params = new URLSearchParams({ key, identifier: 'com.plexapp.plugins.library' });
  return plexFetch(`/:/unscrobble?${params}`, { parseJson: false });
}

function scanLibrary(sectionKey) {
  return plexFetch(`/library/sections/${encodeKey(sectionKey, 'Plex library id')}/refresh`, {
    parseJson: false,
  });
}

function reportTimeline(ratingKey, state, timeMs, durationMs) {
  const key = decodeURIComponent(encodeKey(ratingKey));
  const params = new URLSearchParams({
    ratingKey: key,
    key: `/library/metadata/${key}`,
    state, // 'playing' | 'paused' | 'stopped'
    time: String(timeMs),
    duration: String(durationMs),
    identifier: 'com.plexapp.plugins.library',
  });
  return plexFetch(`/:/timeline?${params}`, { parseJson: false });
}

module.exports = {
  setToken,
  hasToken,
  getPlexUrl,
  getSections,
  getLibraryPaths,
  getItems,
  getSeasons,
  getEpisodes,
  getItemFull,
  getImage,
  getOnDeck,
  getRelated,
  getRecentlyAdded,
  markWatched,
  markUnwatched,
  scanLibrary,
  reportTimeline,
};
