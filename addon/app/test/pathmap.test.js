const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = path.join(os.tmpdir(), `media-launcher-pathmap-test-${process.pid}`);
const { toWindowsPath } = require('../src/pathmap');

test('maps an exact root and a child path', () => {
  process.env.PATH_MAP = JSON.stringify([{ from: '/media/movies', to: '//nas/Movies' }]);
  assert.equal(toWindowsPath('/media/movies'), '\\\\nas\\Movies');
  assert.equal(toWindowsPath('/media/movies/Film/movie.mkv'), '\\\\nas\\Movies\\Film\\movie.mkv');
});

test('does not match a neighboring path with the same prefix', () => {
  process.env.PATH_MAP = JSON.stringify([{ from: '/media/movie', to: '//nas/Movies' }]);
  assert.throws(() => toWindowsPath('/media/movies-other/movie.mkv'), /No path mapping rule matches/);
});

test('accepts a mapping with a trailing slash without weakening the boundary', () => {
  process.env.PATH_MAP = JSON.stringify([{ from: '/media/tv/', to: '//nas/TV' }]);
  assert.equal(toWindowsPath('/media/tv/show/episode.mkv'), '\\\\nas\\TV\\show\\episode.mkv');
  assert.throws(() => toWindowsPath('/media/tv-old/episode.mkv'), /No path mapping rule matches/);
});
