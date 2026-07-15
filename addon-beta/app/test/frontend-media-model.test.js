const assert = require('node:assert/strict');
const test = require('node:test');

const {
  cardPresentation,
  progressPercent,
  recentPresentation,
  routeForItem,
} = require('../public/media-model');

test('routes opaque IDs without interpreting or exposing path separators', () => {
  assert.equal(routeForItem({ id: 'movie / one', kind: 'movie' }), '#/item/movie%20%2F%20one');
  assert.equal(routeForItem({ id: 'series / one', kind: 'series' }), '#/series/series%20%2F%20one');
});

test('routes seasons and episodes to their canonical series', () => {
  const episode = {
    id: 'episode-1',
    kind: 'episode',
    hierarchy: { seriesId: 'series/1' },
  };
  assert.equal(routeForItem(episode), '#/series/series%2F1');
});

test('calculates bounded progress and rejects invalid durations', () => {
  assert.equal(progressPercent({ resumePositionMs: 30, durationMs: 120 }), 25);
  assert.equal(progressPercent({ resumePositionMs: 150, durationMs: 100 }), 100);
  assert.equal(progressPercent({ resumePositionMs: -1, durationMs: 100 }), 0);
  assert.equal(progressPercent({ resumePositionMs: 10, durationMs: 0 }), 0);
  assert.equal(progressPercent({ resumePositionMs: 'bad', durationMs: 100 }), 0);
});

test('uses series and season labels for recently added episodes', () => {
  const item = {
    id: 'episode-1',
    kind: 'episode',
    title: 'The Episode',
    hierarchy: { seriesTitle: 'The Show', seasonTitle: 'Season 4' },
  };
  assert.deepEqual(cardPresentation(item, 'recent'), {
    title: 'The Show',
    subtitle: 'Season 4',
  });
});

test('collapses recently added episodes per season even in mixed results', () => {
  const movie = { id: 'movie-1', kind: 'movie', title: 'Movie', year: 2026 };
  const first = {
    id: 'episode-1',
    kind: 'episode',
    title: 'One',
    hierarchy: { seriesId: 'show-1', seriesTitle: 'Show', seasonId: 'season-1' },
  };
  const duplicateSeason = {
    id: 'episode-2',
    kind: 'episode',
    title: 'Two',
    hierarchy: { seriesId: 'show-1', seriesTitle: 'Show', seasonId: 'season-1' },
  };
  const nextSeason = {
    id: 'episode-3',
    kind: 'episode',
    title: 'Three',
    hierarchy: { seriesId: 'show-1', seriesTitle: 'Show', seasonId: 'season-2' },
  };
  const presented = recentPresentation([movie, first, duplicateSeason, nextSeason]);
  assert.deepEqual(presented.map((entry) => entry.item.id), ['movie-1', 'episode-1', 'episode-3']);
  assert.equal(presented[1].title, 'Show');
});
