'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { MediaProviderError } = require('../src/media-model');
const { decodeImageRef, encodeImageRef } = require('../src/media-image-ref');
const {
  JellyfinProvider,
  createJellyfinProvider,
  normalizeJellyfinItem,
} = require('../src/providers/jellyfin-provider');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'jellyfin');
const BASE_URL = 'http://jellyfin.test:8096/proxy';
const ACCESS_TOKEN = 'fixture-token';
const USER_ID = 'user_fixture';
const DEVICE_ID = 'device_fixture';

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

function movieFixture() {
  return fixture('library-items.json').Items[0];
}

function episodeFixture(id) {
  return fixture('episodes.json').Items.find((item) => item.Id === id);
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptyResponse(status = 204) {
  return new Response(null, { status });
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

function pathRouter(routes) {
  return createFetch((call) => {
    const value = routes[call.url.pathname];
    if (value === undefined) throw new Error(`Unexpected fixture request: ${call.url.href}`);
    const resolved = typeof value === 'function' ? value(call) : value;
    return resolved instanceof Response ? resolved : jsonResponse(resolved);
  });
}

function createProvider(fetchImpl, isAdministrator = true) {
  return createJellyfinProvider({
    baseUrl: BASE_URL,
    accessToken: ACCESS_TOKEN,
    userId: USER_ID,
    deviceId: DEVICE_ID,
    isAdministrator,
    fetchImpl,
  });
}

function assertModernAuth(call) {
  assert.match(call.options.headers.Authorization, /^MediaBrowser /);
  assert.match(call.options.headers.Authorization, /Client="Media%20Launcher"/);
  assert.match(call.options.headers.Authorization, /DeviceId="device_fixture"/);
  assert.match(call.options.headers.Authorization, /Token="fixture-token"/);
  assert.doesNotMatch(call.options.headers.Authorization, /Bearer|X-Emby/i);
  assert.equal(call.options.headers['X-Emby-Token'], undefined);
  assert.equal(call.url.searchParams.has('api_key'), false);
  assert.equal(call.options.redirect, 'manual');
  assert.equal(call.options.signal instanceof AbortSignal, true);
}

test('JellyfinProvider snapshots config, preserves base paths, and uses modern auth', async () => {
  const fake = pathRouter({
    '/proxy/UserViews': fixture('user-views.json'),
  });
  const options = {
    baseUrl: `${BASE_URL}/`,
    accessToken: ACCESS_TOKEN,
    userId: USER_ID,
    deviceId: DEVICE_ID,
    isAdministrator: true,
    fetchImpl: fake.fetchImpl,
  };
  const provider = createJellyfinProvider(options);
  options.baseUrl = 'http://changed.invalid';
  options.accessToken = 'changed';
  options.userId = 'changed';
  options.deviceId = 'changed';
  options.isAdministrator = false;
  options.fetchImpl = async () => { throw new Error('changed fetch'); };

  const libraries = await provider.listLibraries();
  assert.equal(provider instanceof JellyfinProvider, true);
  assert.equal(provider.kind, 'jellyfin');
  assert.equal(Object.isFrozen(provider), true);
  assert.equal(Object.isFrozen(provider.capabilities), true);
  assert.equal(provider.capabilities.scanLibrary, true);
  assert.deepEqual(provider.getConnectionState(), {
    provider: 'jellyfin',
    configured: true,
    linked: true,
  });
  assert.deepEqual(libraries, [
    { id: 'lib_movies', title: 'Movies', kind: 'movie', canScan: true, provider: 'jellyfin' },
    { id: 'lib_tv', title: 'Television', kind: 'series', canScan: true, provider: 'jellyfin' },
  ]);
  assert.equal(fake.calls[0].url.pathname, '/proxy/UserViews');
  assert.equal(fake.calls[0].url.searchParams.get('userId'), USER_ID);
  assert.equal(fake.calls[0].url.searchParams.get('includeExternalContent'), 'false');
  assertModernAuth(fake.calls[0]);
});

test('library paths and global scans are administrator-only capabilities', async () => {
  const adminFetch = pathRouter({
    '/proxy/Library/VirtualFolders': fixture('virtual-folders.json'),
    '/proxy/Library/Refresh': emptyResponse(),
  });
  const admin = createProvider(adminFetch.fetchImpl, true);
  assert.deepEqual(await admin.listLibraryPaths(), [
    { path: '/srv/media/Movies', library: 'Movies', libraryId: 'lib_movies' },
    { path: '/srv/archive/Movies', library: 'Movies', libraryId: 'lib_movies' },
    { path: '/srv/media/Television', library: 'Television', libraryId: 'lib_tv' },
  ]);
  await admin.scanLibrary('lib_movies');
  assert.equal(adminFetch.calls[1].options.method, 'POST');
  assertModernAuth(adminFetch.calls[1]);

  const nonAdminFetch = createFetch(() => { throw new Error('must not fetch'); });
  const nonAdmin = createProvider(nonAdminFetch.fetchImpl, false);
  assert.equal(nonAdmin.capabilities.scanLibrary, false);
  await assert.rejects(
    nonAdmin.listLibraryPaths(),
    (error) => error instanceof MediaProviderError && error.status === 403
  );
  await assert.rejects(
    nonAdmin.scanLibrary('lib_movies'),
    (error) => error instanceof MediaProviderError && error.status === 403
  );
  assert.equal(nonAdminFetch.calls.length, 0);
});

test('normalizes Jellyfin media exactly while keeping source paths private', async () => {
  const fake = createFetch((call) => {
    if (call.url.pathname === '/proxy/Items/movie_1') return jsonResponse(movieFixture());
    if (call.url.pathname === '/proxy/Items') return jsonResponse(fixture('library-items.json'));
    throw new Error(`Unexpected fixture request: ${call.url.href}`);
  });
  const provider = createProvider(fake.fetchImpl);

  const items = await provider.listItems('lib_movies');
  assert.equal(items.length, 2, 'unsupported audio records are excluded');
  const movie = items[0];
  assert.equal(movie.id, 'movie_1');
  assert.equal(movie.provider, 'jellyfin');
  assert.equal(movie.kind, 'movie');
  assert.equal(movie.durationMs, 7200000);
  assert.equal(movie.resumePositionMs, 120000);
  assert.equal(movie.watched, true);
  assert.equal(movie.playable, true);
  assert.deepEqual(movie.genres, ['Drama', 'Adventure']);
  assert.deepEqual(movie.directors, ['Alex Example']);
  assert.deepEqual(movie.ratings, { critic: 74, audience: 82 });
  assert.deepEqual(movie.technical.video, { resolution: '1080', codec: 'h264' });
  assert.deepEqual(movie.technical.audioTracks, [
    { language: 'eng', codec: 'aac', channels: 6 },
  ]);
  assert.deepEqual(movie.technical.subtitleTracks, [
    { language: 'dan', codec: 'srt', forced: true },
  ]);
  assert.equal(movie.cast[1].image, null);
  assert.equal(movie.addedAt, '2023-11-14T22:13:20.000Z');
  const decodedPoster = decodeImageRef(movie.images.poster, 'jellyfin');
  assert.match(decodedPoster.path, /^\/Items\/movie_1\/Images\/Primary\?/);
  assert.doesNotMatch(JSON.stringify(items), /\/srv\/media|\/srv\/archive|"Path"|sourcePath/);

  const series = items[1];
  assert.deepEqual(series.counts, { children: 2, episodes: 10, watchedEpisodes: 7 });
  assert.equal(series.playable, false);

  const detail = await provider.getItem('movie_1');
  assert.equal(detail.id, movie.id);
  assert.doesNotMatch(JSON.stringify(detail), /\/srv\/media|"Path"|sourcePath/);

  const listCall = fake.calls[0];
  assert.equal(listCall.url.searchParams.get('parentId'), 'lib_movies');
  assert.equal(listCall.url.searchParams.get('recursive'), 'true');
  assert.equal(listCall.url.searchParams.get('includeItemTypes'), 'Movie,Series');
  assert.equal(listCall.url.searchParams.get('startIndex'), '0');
  assert.equal(listCall.url.searchParams.get('limit'), '200');
  assert.equal(listCall.url.searchParams.get('enableTotalRecordCount'), 'true');
});

test('paginates Jellyfin libraries instead of silently truncating at 200 items', async () => {
  const values = Array.from({ length: 201 }, (_, index) => ({
    Id: `movie_${index}`,
    Type: 'Movie',
    Name: `Movie ${index}`,
  }));
  const fake = createFetch((call) => {
    const start = Number(call.url.searchParams.get('startIndex'));
    const limit = Number(call.url.searchParams.get('limit'));
    return jsonResponse({
      Items: values.slice(start, start + limit),
      TotalRecordCount: values.length,
    });
  });
  const provider = createProvider(fake.fetchImpl);

  const items = await provider.listItems('lib_movies');

  assert.equal(items.length, 201);
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[1].url.searchParams.get('startIndex'), '200');
});

test('bounds all Jellyfin library pages with one aggregate deadline', async () => {
  const page = Array.from({ length: 200 }, (_, index) => ({
    Id: `movie_${index}`,
    Type: 'Movie',
    Name: `Movie ${index}`,
  }));
  const fake = createFetch(() => jsonResponse({
    Items: page,
    TotalRecordCount: 201,
  }));
  const clockValues = [0, 0, 60001];
  const provider = createJellyfinProvider({
    baseUrl: BASE_URL,
    accessToken: ACCESS_TOKEN,
    userId: USER_ID,
    deviceId: DEVICE_ID,
    isAdministrator: true,
    fetchImpl: fake.fetchImpl,
    nowImpl: () => clockValues.shift() ?? 60001,
  });

  await assert.rejects(
    provider.listItems('lib_movies'),
    (error) => error instanceof MediaProviderError &&
      error.status === 504 && error.code === 'provider_timeout'
  );
  assert.equal(fake.calls.length, 1);
});

test('uses direct critic percentages and ten-point community ratings with clamping', () => {
  const high = normalizeJellyfinItem({
    Id: 'high',
    Type: 'Movie',
    Name: 'High',
    CriticRating: 150,
    CommunityRating: -2,
  });
  assert.deepEqual(high.ratings, { critic: 100, audience: 0 });

  const absent = normalizeJellyfinItem({
    Id: 'absent',
    Type: 'Movie',
    Name: 'Absent',
    CriticRating: null,
  });
  assert.deepEqual(absent.ratings, { critic: null, audience: null });
});

test('implements current Jellyfin feeds, hierarchy, related, and search routes', async () => {
  const fake = createFetch((call) => {
    const fixtures = {
      '/proxy/Items/Latest': fixture('latest.json'),
      '/proxy/UserItems/Resume': fixture('resume.json'),
      '/proxy/Shows/series_1/Seasons': fixture('seasons.json'),
      '/proxy/Shows/series_1/Episodes': fixture('episodes.json'),
      '/proxy/Items/movie_1/Similar': fixture('similar.json'),
      '/proxy/Items': fixture('search.json'),
    };
    const value = fixtures[call.url.pathname];
    if (!value) throw new Error(`Unexpected fixture request: ${call.url.href}`);
    return jsonResponse(value);
  });
  const provider = createProvider(fake.fetchImpl);

  const recent = await provider.listRecentlyAdded('lib_tv');
  assert.equal(recent[0].kind, 'episode');
  assert.equal(recent[0].hierarchy.seriesId, 'series_1');
  assert.equal(recent[0].addedAt, '2023-11-14T22:15:00.000Z');

  const continued = await provider.listContinueWatching();
  assert.equal(continued[0].resumePositionMs, 900000);
  assert.equal(continued[0].hierarchy.episodeNumber, 2);

  const seasons = await provider.getSeasons('series_1');
  assert.deepEqual(seasons[0].hierarchy, {
    seriesId: 'series_1',
    seasonId: 'season_1',
    seriesTitle: 'Example Series',
    seasonTitle: 'Season 1',
    seasonNumber: 1,
    episodeNumber: null,
  });
  const episodes = await provider.getEpisodes('series_1', 'season_1');
  assert.deepEqual(episodes.map((episode) => episode.id), [
    'episode_2',
    'episode_1',
    'episode_3',
  ]);
  assert.deepEqual((await provider.getRelated('movie_1')).map((item) => item.id), ['movie_2']);
  assert.deepEqual((await provider.search(' Example ')).map((item) => item.kind), [
    'movie',
    'series',
    'episode',
  ]);
  assert.deepEqual(await provider.search('  '), []);

  assert.equal(fake.calls[0].url.pathname, '/proxy/Items/Latest');
  assert.equal(fake.calls[0].url.searchParams.get('parentId'), 'lib_tv');
  assert.equal(fake.calls[0].url.searchParams.get('limit'), '50');
  assert.equal(fake.calls[3].url.searchParams.get('seasonId'), 'season_1');
  assert.equal(fake.calls[5].url.searchParams.get('searchTerm'), 'Example');
  assert.equal(fake.calls[5].url.searchParams.get('includeItemTypes'), 'Movie,Series,Episode');
});

test('resolvePlayback selects a File source and keeps session context private', async () => {
  const fake = pathRouter({
    '/proxy/Items/movie_1': movieFixture(),
    '/proxy/Items/movie_1/PlaybackInfo': fixture('playback-info.json'),
  });
  const provider = createProvider(fake.fetchImpl);
  const playback = await provider.resolvePlayback('movie_1');

  assert.equal(
    playback.sourcePath,
    '/srv/media/Movies/Example Film (2024)/Example Film.mkv'
  );
  assert.equal(playback.item.playable, true);
  assert.equal(playback.resumePositionMs, 120000);
  assert.deepEqual(playback.context, {
    provider: 'jellyfin',
    itemId: 'movie_1',
    kind: 'movie',
    seriesId: null,
    seasonId: null,
    seasonNumber: null,
    episodeNumber: null,
    mediaSourceId: 'source_movie',
    playSessionId: 'play_session_1',
  });
  assert.doesNotMatch(JSON.stringify(playback.item), /\/srv\/|"Path"|sourcePath/);
  assert.equal(fake.calls[1].url.searchParams.get('userId'), USER_ID);

  const unavailableFetch = pathRouter({
    '/proxy/Items/movie_1': movieFixture(),
    '/proxy/Items/movie_1/PlaybackInfo': {
      PlaySessionId: 'other_session',
      MediaSources: [{ Id: 'remote_source', Protocol: 'Http', Path: 'https://cdn.invalid/a' }],
    },
  });
  const unavailable = createProvider(unavailableFetch.fetchImpl);
  await assert.rejects(
    unavailable.resolvePlayback('movie_1'),
    (error) => error instanceof MediaProviderError &&
      error.status === 422 && error.code === 'playback_source_unavailable'
  );
});

test('getNextPlayable sorts episodes and never crosses a season boundary', async () => {
  const fake = createFetch((call) => {
    if (call.url.pathname === '/proxy/Shows/series_1/Episodes') {
      return jsonResponse(fixture('episodes.json'));
    }
    if (call.url.pathname === '/proxy/Items/episode_2') {
      return jsonResponse(episodeFixture('episode_2'));
    }
    if (call.url.pathname === '/proxy/Items/episode_2/PlaybackInfo') {
      return jsonResponse({
        PlaySessionId: 'episode_session_2',
        MediaSources: [episodeFixture('episode_2').MediaSources[0]],
      });
    }
    throw new Error(`Unexpected fixture request: ${call.url.href}`);
  });
  const provider = createProvider(fake.fetchImpl);
  const context = {
    provider: 'jellyfin',
    kind: 'episode',
    seriesId: 'series_1',
    seasonId: 'season_1',
  };

  const next = await provider.getNextPlayable({ ...context, itemId: 'episode_1' });
  assert.equal(next.item.id, 'episode_2');
  assert.match(next.sourcePath, /Episode 02\.mkv$/);
  assert.equal(
    await provider.getNextPlayable({ ...context, itemId: 'episode_3' }),
    null
  );
  assert.equal(
    await provider.getNextPlayable({ provider: 'jellyfin', kind: 'movie', itemId: 'movie_1' }),
    null
  );
});

test('watched and progress events use modern endpoints and exact Jellyfin ticks', async () => {
  const fake = createFetch(() => emptyResponse());
  const provider = createProvider(fake.fetchImpl, true);
  const context = {
    provider: 'jellyfin',
    itemId: 'movie_1',
    mediaSourceId: 'source_movie',
    playSessionId: 'play_session_1',
  };

  await provider.setWatched('movie_1', true);
  await provider.setWatched('movie_1', false);
  await provider.reportProgress('movie_1', {
    state: 'playing',
    positionMs: 1234.5,
    durationMs: 5678,
    context,
  });
  await provider.reportProgress('movie_1', {
    state: 'paused',
    positionMs: 2000,
    durationMs: 5678,
    context,
  });
  await provider.reportProgress('movie_1', {
    state: 'stopped',
    positionMs: 2500,
    durationMs: 5678,
    context,
  });
  await provider.scanLibrary('lib_movies');

  assert.equal(fake.calls[0].url.pathname, '/proxy/UserPlayedItems/movie_1');
  assert.equal(fake.calls[0].options.method, 'POST');
  assert.equal(fake.calls[1].options.method, 'DELETE');
  assert.equal(fake.calls[0].url.searchParams.get('userId'), USER_ID);
  assert.deepEqual(fake.calls.slice(2, 5).map((call) => call.url.pathname), [
    '/proxy/Sessions/Playing',
    '/proxy/Sessions/Playing/Progress',
    '/proxy/Sessions/Playing/Stopped',
  ]);

  const start = JSON.parse(fake.calls[2].options.body);
  assert.deepEqual(start, {
    ItemId: 'movie_1',
    MediaSourceId: 'source_movie',
    PlaySessionId: 'play_session_1',
    PositionTicks: 12345000,
    RunTimeTicks: 56780000,
    PlayMethod: 'DirectPlay',
    CanSeek: true,
    IsPaused: false,
  });
  assert.equal(JSON.parse(fake.calls[3].options.body).IsPaused, true);
  assert.deepEqual(JSON.parse(fake.calls[4].options.body), {
    ItemId: 'movie_1',
    MediaSourceId: 'source_movie',
    PlaySessionId: 'play_session_1',
    PositionTicks: 25000000,
    Failed: false,
  });
  assert.equal(fake.calls[5].url.pathname, '/proxy/Library/Refresh');
  assert.equal(fake.calls.every((call) => call.options.headers['Content-Type'] === undefined ||
    call.options.headers['Content-Type'] === 'application/json'), true);
  fake.calls.forEach(assertModernAuth);
});

test('openArtwork only accepts provider-owned item image routes and safe parameters', async () => {
  const itemFetch = pathRouter({
    '/proxy/Items/movie_1': movieFixture(),
  });
  const itemProvider = createProvider(itemFetch.fetchImpl);
  const item = await itemProvider.getItem('movie_1');

  const artworkFetch = createFetch(() => new Response('image', {
    status: 200,
    headers: { 'Content-Type': 'image/jpeg' },
  }));
  const provider = createProvider(artworkFetch.fetchImpl);
  const response = await provider.openArtwork(item.images.poster);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(artworkFetch.calls[0].url.pathname, '/proxy/Items/movie_1/Images/Primary');
  assert.equal(artworkFetch.calls[0].url.searchParams.get('tag'), 'poster_tag');
  assert.equal(artworkFetch.calls[0].url.searchParams.get('maxWidth'), '480');
  assert.equal(artworkFetch.calls[0].url.searchParams.get('quality'), '90');
  assert.equal(artworkFetch.calls[0].options.headers.Accept, 'image/*');
  assertModernAuth(artworkFetch.calls[0]);

  const invalid = [
    '/Items/movie_1/Images/Primary',
    encodeImageRef('plex', '/Items/movie_1/Images/Primary'),
    encodeImageRef('jellyfin', 'https://attacker.invalid/image.jpg'),
    encodeImageRef('jellyfin', '/Items/movie_1/Download'),
    encodeImageRef('jellyfin', '/Items/movie_1/Images/Primary?api_key=secret'),
    encodeImageRef('jellyfin', '/Items/movie_1/Images/Primary?tag=ok&token=secret'),
    encodeImageRef('jellyfin', '/Items/movie_1/Images/Primary/../../Download?tag=ok'),
  ];
  for (const ref of invalid) {
    assert.throws(
      () => provider.openArtwork(ref),
      (error) => error instanceof MediaProviderError && error.status === 400
    );
  }
  assert.equal(artworkFetch.calls.length, 1, 'invalid refs never reach fetch');
});

test('rejects redirects, unsafe ids, invalid JSON, and unavailable servers safely', async () => {
  const redirected = createProvider(async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    return new Response(null, {
      status: 302,
      headers: { Location: 'https://attacker.invalid/collect' },
    });
  });
  await assert.rejects(
    redirected.listLibraries(),
    (error) => error instanceof MediaProviderError &&
      error.status === 502 && error.code === 'provider_redirect_rejected'
  );

  const offline = createProvider(async () => { throw new Error('ECONNREFUSED'); });
  await assert.rejects(
    offline.listLibraries(),
    (error) => error instanceof MediaProviderError &&
      error.status === 502 && error.code === 'provider_unreachable'
  );

  const malformed = createProvider(async () => new Response('{', { status: 200 }));
  await assert.rejects(
    malformed.listLibraries(),
    (error) => error instanceof MediaProviderError &&
      error.status === 502 && error.code === 'invalid_provider_response'
  );

  const noFetch = createFetch(() => { throw new Error('must not fetch'); });
  const strict = createProvider(noFetch.fetchImpl);
  await assert.rejects(
    strict.getItem('../escape'),
    (error) => error instanceof MediaProviderError && error.status === 400
  );
  await assert.rejects(
    strict.search('x'.repeat(257)),
    (error) => error instanceof MediaProviderError && error.status === 400
  );
  await assert.rejects(
    strict.reportProgress('movie_1', {
      state: 'playing',
      positionMs: 1,
      durationMs: 2,
      context: { mediaSourceId: 'source_movie' },
    }),
    (error) => error instanceof MediaProviderError && error.status === 400
  );
  assert.equal(noFetch.calls.length, 0);
});
