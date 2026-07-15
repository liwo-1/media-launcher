'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const { createMediaRouter } = require('../src/routes/media');

async function startServer(t, provider) {
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use('/api/media', createMediaRouter({ providerFactory: () => provider }));
  const server = await new Promise((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function providerHarness() {
  const calls = [];
  const item = { id: 'item-1', provider: 'plex', kind: 'movie', title: 'Movie' };
  return {
    calls,
    provider: {
      listLibraries: async () => [{ id: 'library-1', provider: 'plex', kind: 'movie' }],
      listItems: async (...args) => (calls.push(['listItems', ...args]), [item]),
      listRecentlyAdded: async (...args) => (calls.push(['recent', ...args]), [item]),
      listContinueWatching: async () => [item],
      search: async (...args) => (calls.push(['search', ...args]), [item]),
      getItem: async (...args) => (calls.push(['item', ...args]), item),
      getRelated: async (...args) => (calls.push(['related', ...args]), [item]),
      getSeasons: async (...args) => (calls.push(['seasons', ...args]), []),
      getEpisodes: async (...args) => (calls.push(['episodes', ...args]), [item]),
      setWatched: async (...args) => calls.push(['watched', ...args]),
      scanLibrary: async (...args) => calls.push(['scan', ...args]),
      openArtwork: async (...args) => {
        calls.push(['artwork', ...args]);
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'Content-Type': 'image/jpeg; charset=binary', ETag: 'image-tag' },
        });
      },
    },
  };
}

async function json(response) {
  const body = await response.json();
  assert.equal(response.headers.get('content-type').startsWith('application/json'), true);
  return body;
}

test('routes every normalized browse operation through one request-scoped provider', async (t) => {
  const harness = providerHarness();
  const base = await startServer(t, harness.provider);
  const cases = [
    ['/api/media/libraries', 'GET', 'items'],
    ['/api/media/libraries/library-1/items', 'GET', 'items'],
    ['/api/media/libraries/library-1/recently-added', 'GET', 'items'],
    ['/api/media/continue-watching', 'GET', 'items'],
    ['/api/media/search?q=Alien', 'GET', 'items'],
    ['/api/media/items/item-1/related', 'GET', 'items'],
    ['/api/media/series/show-1/seasons', 'GET', 'items'],
    ['/api/media/series/show-1/seasons/season-1/episodes', 'GET', 'items'],
  ];
  for (const [path, method, key] of cases) {
    const response = await fetch(`${base}${path}`, { method });
    assert.equal(response.status, 200, path);
    assert.equal(Array.isArray((await json(response))[key]), true, path);
  }

  const itemResponse = await fetch(`${base}/api/media/items/item-1`);
  assert.equal(itemResponse.status, 200);
  assert.equal((await json(itemResponse)).id, 'item-1');
  assert.deepEqual(harness.calls.find((call) => call[0] === 'episodes'), [
    'episodes', 'show-1', 'season-1',
  ]);
  assert.deepEqual(harness.calls.find((call) => call[0] === 'search'), ['search', 'Alien']);
});

test('validates watched, scan, search, and identifiers before provider mutations', async (t) => {
  const harness = providerHarness();
  const base = await startServer(t, harness.provider);

  const watched = await fetch(`${base}/api/media/items/item-1/watched`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ watched: false }),
  });
  assert.equal(watched.status, 200);
  assert.deepEqual(harness.calls.find((call) => call[0] === 'watched'), [
    'watched', 'item-1', false,
  ]);

  const invalidWatched = await fetch(`${base}/api/media/items/item-1/watched`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ watched: 'yes' }),
  });
  assert.equal(invalidWatched.status, 400);

  const missingSearch = await fetch(`${base}/api/media/search`);
  assert.equal(missingSearch.status, 400);

  const scan = await fetch(`${base}/api/media/libraries/library-1/scan`, { method: 'POST' });
  assert.equal(scan.status, 200);
  assert.deepEqual(harness.calls.find((call) => call[0] === 'scan'), ['scan', 'library-1']);
});

test('streams only image responses through opaque references with safe response headers', async (t) => {
  const harness = providerHarness();
  const base = await startServer(t, harness.provider);
  const response = await fetch(`${base}/api/media/images/${encodeURIComponent('plex:opaque')}`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('etag'), 'image-tag');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
  assert.deepEqual(harness.calls.find((call) => call[0] === 'artwork'), [
    'artwork', 'plex:opaque',
  ]);
});

test('rejects non-image upstream bodies without reflecting an unexpected error', async (t) => {
  const harness = providerHarness();
  harness.provider.openArtwork = async () => new Response('not an image', {
    headers: { 'Content-Type': 'text/html' },
  });
  const base = await startServer(t, harness.provider);
  const response = await fetch(`${base}/api/media/images/${encodeURIComponent('plex:opaque')}`);
  assert.equal(response.status, 502);
  assert.deepEqual(await json(response), { error: 'The media server returned invalid artwork.' });

  harness.provider.openArtwork = async () => new Response('<svg></svg>', {
    headers: { 'Content-Type': 'image/svg+xml' },
  });
  const svgResponse = await fetch(`${base}/api/media/images/${encodeURIComponent('plex:opaque')}`);
  assert.equal(svgResponse.status, 502);
});
