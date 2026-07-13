const { getStoredToken } = require('./token-store');
const { readSettings } = require('./settings-store');

// A token set directly in add-on options wins; otherwise fall back to one obtained via the PIN
// linking flow (src/plex-auth.js) and persisted to /data.
let currentToken = process.env.PLEX_TOKEN || getStoredToken() || null;

function setToken(token) {
  currentToken = token;
}

function hasToken() {
  return Boolean(currentToken);
}

function getPlexUrl() {
  return process.env.PLEX_URL || readSettings().plexUrl || null;
}

async function plexFetch(path, { binary = false, parseJson = true } = {}) {
  const plexUrl = getPlexUrl();
  if (!plexUrl) {
    const err = new Error('Plex server URL is not configured yet - set it on the Settings page.');
    err.status = 400;
    throw err;
  }
  if (!currentToken) {
    const err = new Error('Plex account is not linked yet.');
    err.status = 401;
    throw err;
  }
  const url = `${plexUrl}${path}`;
  const response = await fetch(url, {
    headers: {
      'X-Plex-Token': currentToken,
      Accept: 'application/json',
    },
  });

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
  const data = await plexFetch(`/library/sections/${sectionKey}/all`);
  return data.MediaContainer.Metadata || [];
}

async function getRecentlyAdded(sectionKey) {
  const data = await plexFetch(`/library/sections/${sectionKey}/recentlyAdded`);
  return data.MediaContainer.Metadata || [];
}

async function getChildren(ratingKey) {
  const data = await plexFetch(`/library/metadata/${ratingKey}/children`);
  return data.MediaContainer.Metadata || [];
}

function getSeasons(showRatingKey) {
  return getChildren(showRatingKey);
}

function getEpisodes(seasonRatingKey) {
  return getChildren(seasonRatingKey);
}

async function getItemFull(ratingKey) {
  const data = await plexFetch(`/library/metadata/${ratingKey}`);
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
  const data = await plexFetch(`/library/metadata/${ratingKey}/related`);
  const hub = (data.MediaContainer.Hub || [])[0];
  return (hub && hub.Metadata) || [];
}

function markWatched(ratingKey) {
  return plexFetch(
    `/:/scrobble?key=${ratingKey}&identifier=com.plexapp.plugins.library`,
    { parseJson: false }
  );
}

function markUnwatched(ratingKey) {
  return plexFetch(
    `/:/unscrobble?key=${ratingKey}&identifier=com.plexapp.plugins.library`,
    { parseJson: false }
  );
}

function scanLibrary(sectionKey) {
  return plexFetch(`/library/sections/${sectionKey}/refresh`, { parseJson: false });
}

function reportTimeline(ratingKey, state, timeMs, durationMs) {
  const params = new URLSearchParams({
    ratingKey,
    key: `/library/metadata/${ratingKey}`,
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
