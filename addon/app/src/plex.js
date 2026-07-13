const PLEX_URL = process.env.PLEX_URL;
const PLEX_TOKEN = process.env.PLEX_TOKEN;

if (!PLEX_URL || !PLEX_TOKEN) {
  throw new Error('PLEX_URL and PLEX_TOKEN must both be set (add-on options).');
}

async function plexFetch(path, { binary = false, parseJson = true } = {}) {
  const url = `${PLEX_URL}${path}`;
  const response = await fetch(url, {
    headers: {
      'X-Plex-Token': PLEX_TOKEN,
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
  getSections,
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
