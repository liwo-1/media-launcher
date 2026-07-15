const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = path.join(os.tmpdir(), `media-launcher-pathmap-test-${process.pid}`);
const { resolveMediaPath, toWindowsPath } = require('../src/pathmap');

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

test('uses the selected agent mapping instead of the legacy global mapping', () => {
  process.env.PATH_MAP = JSON.stringify([{ from: '/media', to: '//wrong/share' }]);
  const agent = {
    name: 'Living Room',
    platform: 'windows',
    pathMap: [{ from: '/media', to: '//living-room/media' }],
  };
  assert.equal(
    resolveMediaPath('/media/Movies/Film.mkv', agent),
    '\\\\living-room\\media\\Movies\\Film.mkv'
  );
});

test('an empty managed-agent mapping never falls back to legacy global rules', () => {
  process.env.PATH_MAP = JSON.stringify([{ from: '/media', to: '//wrong/share' }]);
  assert.throws(
    () => resolveMediaPath('/media/Movies/Film.mkv', {
      name: 'New Linux player',
      platform: 'linux',
      pathMap: [],
    }),
    /No path mappings are configured for New Linux player/
  );
});

test('preserves forward slashes for a Linux playback target', () => {
  const agent = {
    name: 'Bedroom Linux',
    platform: 'linux',
    pathMap: [{ from: '/volume1/video', to: '/mnt/media' }],
  };
  assert.equal(resolveMediaPath('/volume1/video/Film/movie.mkv', agent), '/mnt/media/Film/movie.mkv');
});

test('maps Windows-style provider paths without weakening root boundaries', () => {
  const agent = {
    platform: 'windows',
    pathMap: [{ from: 'D:\\Media\\Movies\\', to: '\\\\nas\\Movies\\' }],
  };

  assert.equal(
    resolveMediaPath('d:\\media\\movies\\Example.mkv', agent),
    '\\\\nas\\Movies\\Example.mkv'
  );
  assert.throws(
    () => resolveMediaPath('D:\\Media\\Movies-Other\\Example.mkv', agent),
    /No path mapping rule matches/
  );
});

test('does not expose a provider source path when no mapping matches', () => {
  const sourcePath = '/private/library/Household/Example.mkv';
  const agent = {
    name: 'Living Room',
    platform: 'windows',
    pathMap: [{ from: '/media', to: '\\\\nas\\Media' }],
  };

  assert.throws(
    () => resolveMediaPath(sourcePath, agent),
    (error) => /No path mapping rule matches/.test(error.message) &&
      !error.message.includes(sourcePath) && !error.message.includes('/private/library')
  );
});
