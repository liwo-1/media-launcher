'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { MediaProviderError } = require('../src/media-model');
const { decodePlexImageRef, encodeImageRef } = require('../src/media-image-ref');
const {
  PlexProvider,
  createPlexProvider,
  normalizePlexItem,
} = require('../src/providers/plex-provider');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'plex');
const BASE_URL = 'http://plex.test:32400/proxy';
const TOKEN = 'fixture-token';

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const call = { url: new URL(url), options };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { calls, fetchImpl };
}

function routeKey(call) {
  return `${call.url.pathname}${call.url.search}`;
}

function fixtureRouter(routes) {
  return createFetch((call) => {
    const value = routes[routeKey(call)];
    if (!value) throw new Error(`Unexpected fixture request: ${routeKey(call)}`);
    return value instanceof Response ? value : jsonResponse(value);
  });
}

function episodeMetadata(id) {
  const episode = fixture('episodes.json').MediaContainer.Metadata
    .find((candidate) => candidate.ratingKey === String(id));
  return { MediaContainer: { Metadata: episode ? [episode] : [] } };
}

test('PlexProvider snapshots its configuration and sends private auth headers', async () => {
  const first = fixtureRouter({
    '/proxy/library/sections': fixture('sections.json'),
  });
  const options = { baseUrl: `${BASE_URL}/`, token: TOKEN, fetchImpl: first.fetchImpl };
  const provider = createPlexProvider(options);
  options.baseUrl = 'http://changed.invalid';
  options.token = 'changed-token';
  options.fetchImpl = async () => { throw new Error('changed fetch'); };

  const libraries = await provider.listLibraries();
  assert.equal(provider instanceof PlexProvider, true);
  assert.equal(Object.isFrozen(provider), true);
  assert.equal(Object.isFrozen(provider.capabilities), true);
  assert.deepEqual(provider.getConnectionState(), {
    provider: 'plex',
    configured: true,
    linked: true,
  });
  assert.deepEqual(libraries.map((library) => library.kind), ['movie', 'series']);
  assert.equal(first.calls[0].url.href, `${BASE_URL}/library/sections`);
  assert.equal(first.calls[0].options.headers['X-Plex-Token'], TOKEN);
  assert.equal(first.calls[0].options.headers.Accept, 'application/json');
  assert.equal(first.calls[0].options.redirect, 'manual');
  assert.equal(first.calls[0].options.signal instanceof AbortSignal, true);
});

test('normalizes Plex libraries and path discovery into canonical records', async () => {
  const fake = fixtureRouter({
    '/proxy/library/sections': fixture('sections.json'),
  });
  const provider = createPlexProvider({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: fake.fetchImpl });

  assert.deepEqual(await provider.listLibraries(), [
    { id: '1', title: 'Movies', kind: 'movie', canScan: true, provider: 'plex' },
    { id: '2', title: 'Television', kind: 'series', canScan: true, provider: 'plex' },
  ]);
  assert.deepEqual(await provider.listLibraryPaths(), [
    { path: '/srv/media/Movies', library: 'Movies', libraryId: '1' },
    { path: '/srv/archive/Movies', library: 'Movies', libraryId: '1' },
    { path: '/srv/media/Television', library: 'Television', libraryId: '2' },
  ]);
});

test('normalizes public media without disclosing Plex file paths', async () => {
  const fake = fixtureRouter({
    '/proxy/library/sections/1/all': fixture('library-items.json'),
    '/proxy/library/metadata/100': fixture('movie-item.json'),
  });
  const provider = createPlexProvider({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: fake.fetchImpl });

  const items = await provider.listItems('1');
  assert.equal(items.length, 2, 'unsupported music records are excluded');
  const movie = items[0];
  assert.equal(movie.id, '100');
  assert.equal(movie.provider, 'plex');
  assert.equal(movie.kind, 'movie');
  assert.equal(movie.durationMs, 7200000);
  assert.equal(movie.resumePositionMs, 120000);
  assert.equal(movie.watched, true);
  assert.equal(movie.playable, true);
  assert.deepEqual(movie.genres, ['Drama', 'Adventure']);
  assert.deepEqual(movie.directors, ['Alex Example']);
  assert.deepEqual(movie.ratings, { critic: 75, audience: 81 });
  assert.deepEqual(movie.technical.video, { resolution: '1080', codec: 'h264' });
  assert.deepEqual(movie.technical.audioTracks, [
    { language: 'English', codec: 'aac', channels: 6 },
  ]);
  assert.deepEqual(movie.technical.subtitleTracks, [
    { language: 'Danish', codec: 'srt', forced: true },
  ]);
  assert.equal(movie.cast[1].image, null, 'absolute third-party artwork is never proxied');
  assert.equal(movie.addedAt, '2023-11-14T22:13:20.000Z');
  assert.doesNotMatch(JSON.stringify(items), /\/srv\/media|\/srv\/archive|"file"|sourcePath/);

  const detail = await provider.getItem('100');
  assert.equal(detail.id, movie.id);
  assert.doesNotMatch(JSON.stringify(detail), /\/srv\/media|"file"|sourcePath/);
});

test('converts Plex ten-point ratings to clamped canonical percentages', () => {
  const high = normalizePlexItem({
    ratingKey: 'high',
    type: 'movie',
    title: 'High',
    rating: 15,
    audienceRating: -2,
  });
  assert.deepEqual(high.ratings, { critic: 100, audience: 0 });

  const absent = normalizePlexItem({
    ratingKey: 'absent',
    type: 'movie',
    title: 'Absent',
    rating: null,
  });
  assert.deepEqual(absent.ratings, { critic: null, audience: null });
});

test('implements recently added, continue watching, seasons, episodes, related, and search', async () => {
  const fake = fixtureRouter({
    '/proxy/library/sections/2/recentlyAdded': fixture('recently-added.json'),
    '/proxy/library/onDeck': fixture('on-deck.json'),
    '/proxy/library/metadata/200/children': fixture('seasons.json'),
    '/proxy/library/metadata/210/children': fixture('episodes.json'),
    '/proxy/library/metadata/100/related': fixture('related.json'),
    '/proxy/hubs/search?query=Example+Film': fixture('search.json'),
  });
  const provider = createPlexProvider({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: fake.fetchImpl });

  const recent = await provider.listRecentlyAdded('2');
  assert.equal(recent[0].kind, 'episode');
  assert.equal(recent[0].hierarchy.seriesId, '200');
  assert.equal(recent[0].addedAt, '2023-11-14T22:15:00.000Z');
  assert.equal(
    decodePlexImageRef(recent[0].images.poster),
    '/library/metadata/210/thumb/1700000000',
    'episode cards use portrait season artwork'
  );
  assert.equal(
    decodePlexImageRef(recent[0].images.thumbnail),
    '/library/metadata/213/thumb/1700000000',
    'episode detail keeps the episode still'
  );

  const continued = await provider.listContinueWatching();
  assert.equal(continued[0].resumePositionMs, 900000);
  assert.equal(continued[0].hierarchy.episodeNumber, 2);

  const seasons = await provider.getSeasons('200');
  assert.deepEqual(seasons[0].hierarchy, {
    seriesId: '200',
    seasonId: '210',
    seriesTitle: 'Example Series',
    seasonTitle: 'Season 1',
    seasonNumber: 1,
    episodeNumber: null,
  });

  const episodes = await provider.getEpisodes('200', '210');
  assert.deepEqual(episodes.map((episode) => episode.id), ['212', '211', '213']);

  const related = await provider.getRelated('100');
  assert.deepEqual(related.map((item) => item.id), ['101'], 'only the first Plex hub is retained');

  const results = await provider.search(' Example Film ');
  assert.deepEqual(results.map((item) => item.kind), ['movie', 'series']);
  assert.deepEqual(await provider.search('  '), []);
});

test('resolvePlayback preserves first Media/Part selection while keeping it out of public DTOs', async () => {
  const fake = fixtureRouter({
    '/proxy/library/metadata/100': fixture('movie-item.json'),
  });
  const provider = createPlexProvider({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: fake.fetchImpl });

  const playback = await provider.resolvePlayback('100');
  assert.equal(
    playback.sourcePath,
    '/srv/media/Movies/Example Film (2024)/Example Film.mkv'
  );
  assert.equal(playback.resumePositionMs, 120000);
  assert.deepEqual(playback.context, {
    provider: 'plex',
    itemId: '100',
    kind: 'movie',
    seriesId: null,
    seasonId: null,
    seasonNumber: null,
    episodeNumber: null,
  });
  assert.doesNotMatch(JSON.stringify(playback.item), /\/srv\/|"file"|sourcePath/);
});

test('getNextPlayable sorts by episode number and never crosses a season boundary', async () => {
  const fake = fixtureRouter({
    '/proxy/library/metadata/210/children': fixture('episodes.json'),
    '/proxy/library/metadata/212': episodeMetadata('212'),
  });
  const provider = createPlexProvider({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: fake.fetchImpl });
  const baseContext = {
    provider: 'plex',
    kind: 'episode',
    seriesId: '200',
    seasonId: '210',
  };

  const next = await provider.getNextPlayable({ ...baseContext, itemId: '211', episodeNumber: 1 });
  assert.equal(next.item.id, '212');
  assert.match(next.sourcePath, /Episode 02\.mkv$/);

  const last = await provider.getNextPlayable({ ...baseContext, itemId: '213', episodeNumber: 3 });
  assert.equal(last, null);
  assert.equal(await provider.getNextPlayable({ provider: 'plex', kind: 'movie', itemId: '100' }), null);
});

test('watched, progress, and scan actions retain Plex request semantics', async () => {
  const fake = createFetch(() => new Response(null, { status: 200 }));
  const provider = createPlexProvider({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: fake.fetchImpl });

  await provider.setWatched('100', true);
  await provider.setWatched('100', false);
  await provider.reportProgress('100', {
    state: 'playing',
    positionMs: 1234,
    durationMs: 5678,
  });
  await provider.scanLibrary('1');

  assert.equal(fake.calls[0].url.pathname, '/proxy/:/scrobble');
  assert.equal(fake.calls[0].url.searchParams.get('key'), '100');
  assert.equal(fake.calls[1].url.pathname, '/proxy/:/unscrobble');
  assert.equal(fake.calls[2].url.pathname, '/proxy/:/timeline');
  assert.equal(fake.calls[2].url.searchParams.get('ratingKey'), '100');
  assert.equal(fake.calls[2].url.searchParams.get('key'), '/library/metadata/100');
  assert.equal(fake.calls[2].url.searchParams.get('state'), 'playing');
  assert.equal(fake.calls[2].url.searchParams.get('time'), '1234');
  assert.equal(fake.calls[2].url.searchParams.get('duration'), '5678');
  assert.equal(fake.calls[3].url.pathname, '/proxy/library/sections/1/refresh');
  assert.equal(fake.calls.every((call) => call.options.headers['X-Plex-Token'] === TOKEN), true);
});

test('openArtwork accepts only strict provider-owned Plex refs and never arbitrary URLs', async () => {
  const fake = createFetch(() => new Response('image', {
    status: 200,
    headers: { 'Content-Type': 'image/jpeg' },
  }));
  const provider = createPlexProvider({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: fake.fetchImpl });
  const itemFake = fixtureRouter({
    '/proxy/library/metadata/100': fixture('movie-item.json'),
  });
  const itemProvider = createPlexProvider({
    baseUrl: BASE_URL,
    token: TOKEN,
    fetchImpl: itemFake.fetchImpl,
  });
  const item = await itemProvider.getItem('100');

  const response = await provider.openArtwork(item.images.poster);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(fake.calls[0].url.pathname, '/proxy/library/metadata/100/thumb/1700000000');
  assert.equal(fake.calls[0].options.headers.Accept, 'image/*');
  assert.equal(fake.calls[0].options.headers['X-Plex-Token'], TOKEN);

  assert.throws(() => provider.openArtwork('/library/metadata/100/thumb/1'), MediaProviderError);
  assert.throws(
    () => provider.openArtwork(encodeImageRef('plex', 'https://attacker.invalid/image.jpg')),
    (error) => error instanceof MediaProviderError && error.status === 400
  );
  assert.throws(
    () => provider.openArtwork(encodeImageRef('jellyfin', '/library/metadata/100/thumb/1')),
    (error) => error instanceof MediaProviderError && error.status === 400
  );
  assert.equal(fake.calls.length, 1, 'invalid refs never reach fetch');
});

test('normalizes upstream, network, invalid JSON, and missing-item errors with status', async () => {
  const unauthorized = createPlexProvider({
    baseUrl: BASE_URL,
    token: TOKEN,
    fetchImpl: async () => new Response('{}', { status: 401 }),
  });
  await assert.rejects(
    unauthorized.listLibraries(),
    (error) => error instanceof MediaProviderError && error.status === 401
  );

  let redirectCalls = 0;
  const redirected = createPlexProvider({
    baseUrl: BASE_URL,
    token: TOKEN,
    fetchImpl: async (_url, options) => {
      redirectCalls += 1;
      assert.equal(options.redirect, 'manual');
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://attacker.invalid/collect' },
      });
    },
  });
  await assert.rejects(
    redirected.listLibraries(),
    (error) => error instanceof MediaProviderError && error.status === 502 &&
      error.code === 'provider_redirect_rejected'
  );
  assert.equal(redirectCalls, 1, 'redirects are never followed with the Plex token');

  const offline = createPlexProvider({
    baseUrl: BASE_URL,
    token: TOKEN,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  await assert.rejects(
    offline.listLibraries(),
    (error) => error instanceof MediaProviderError && error.status === 502 &&
      error.code === 'provider_unreachable'
  );

  const malformed = createPlexProvider({
    baseUrl: BASE_URL,
    token: TOKEN,
    fetchImpl: async () => new Response('{', { status: 200 }),
  });
  await assert.rejects(
    malformed.listLibraries(),
    (error) => error instanceof MediaProviderError && error.status === 502 &&
      error.code === 'invalid_provider_response'
  );

  const missing = createPlexProvider({
    baseUrl: BASE_URL,
    token: TOKEN,
    fetchImpl: async () => jsonResponse({ MediaContainer: { Metadata: [] } }),
  });
  await assert.rejects(
    missing.getItem('missing'),
    (error) => error instanceof MediaProviderError && error.status === 404
  );
});
