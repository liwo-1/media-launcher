'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MediaProviderError,
  createLibrary,
  createMediaItem,
  createPlaybackDescriptor,
} = require('../src/media-model');
const {
  MAX_IMAGE_PATH_BYTES,
  decodeImageRef,
  decodePlexImageRef,
  encodeImageRef,
  encodePlexImageRef,
} = require('../src/media-image-ref');

test('canonical library and item builders return an exact provider-neutral shape', () => {
  const library = createLibrary({
    id: 'library-1',
    title: 'Movies',
    kind: 'movie',
    canScan: true,
    provider: 'plex',
    ignored: 'not public',
  });
  assert.deepEqual(library, {
    id: 'library-1',
    title: 'Movies',
    kind: 'movie',
    canScan: true,
    provider: 'plex',
  });

  const item = createMediaItem({
    id: 'item-1',
    provider: 'plex',
    kind: 'episode',
    title: 'Pilot',
    sourcePath: '/private/media/Pilot.mkv',
    file: '/private/media/Pilot.mkv',
    hierarchy: { seriesId: 'show-1', seasonId: 'season-1', episodeNumber: 1 },
    technical: {
      video: { resolution: '1080', codec: 'h264' },
      audioTracks: [{ language: 'English', codec: 'aac', channels: 6, private: true }],
      subtitleTracks: [{ language: 'Danish', codec: 'srt', forced: true }],
    },
  });

  assert.deepEqual(Object.keys(item), [
    'id', 'provider', 'kind', 'title', 'year', 'summary', 'contentRating', 'durationMs',
    'resumePositionMs', 'watched', 'playable', 'images', 'hierarchy', 'counts', 'genres',
    'directors', 'cast', 'ratings', 'technical', 'addedAt',
  ]);
  assert.equal(item.hierarchy.seriesId, 'show-1');
  assert.equal(item.hierarchy.episodeNumber, 1);
  assert.equal(item.technical.audioTracks[0].private, undefined);
  assert.doesNotMatch(JSON.stringify(item), /private\/media|sourcePath|"file"/);
});

test('playback descriptors keep the source path private from their canonical item', () => {
  const descriptor = createPlaybackDescriptor({
    item: {
      id: 'item-1',
      provider: 'plex',
      kind: 'movie',
      title: 'Example',
      sourcePath: '/should/not/copy.mkv',
    },
    sourcePath: '/private/media/Example.mkv',
    resumePositionMs: 1234,
    context: { provider: 'plex', itemId: 'item-1' },
  });

  assert.equal(descriptor.sourcePath, '/private/media/Example.mkv');
  assert.equal(descriptor.resumePositionMs, 1234);
  assert.doesNotMatch(JSON.stringify(descriptor.item), /private|sourcePath/);
});

test('canonical builders reject unsupported kinds and provider errors carry stable metadata', () => {
  assert.throws(
    () => createLibrary({ id: '1', title: 'Music', kind: 'music', provider: 'plex' }),
    /Unsupported library kind/
  );
  assert.throws(
    () => createMediaItem({ id: '1', title: 'Track', kind: 'track', provider: 'plex' }),
    /Unsupported media item kind/
  );

  const error = new MediaProviderError('Unavailable', {
    status: 503,
    code: 'offline',
    provider: 'plex',
  });
  assert.equal(error.status, 503);
  assert.equal(error.code, 'offline');
  assert.equal(error.provider, 'plex');
});

test('opaque artwork references are provider-qualified, canonical, and strictly decoded', () => {
  const ref = encodeImageRef('plex', '/library/metadata/1/thumb/2');
  assert.match(ref, /^plex:[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeImageRef(ref, 'plex'), {
    provider: 'plex',
    path: '/library/metadata/1/thumb/2',
  });

  assert.throws(() => decodeImageRef(ref, 'jellyfin'), /different provider/);
  assert.throws(() => decodeImageRef(`${ref}=`, 'plex'), /encoding/);
  assert.throws(() => decodeImageRef('plex:_w', 'plex'), /encoding/);
  assert.throws(
    () => encodeImageRef('plex', 'x'.repeat(MAX_IMAGE_PATH_BYTES + 1)),
    /too long/
  );
});

test('Plex artwork references only decode to bounded credential-free /library/ paths', () => {
  const ref = encodePlexImageRef('/library/metadata/1/art/2?width=1280');
  assert.equal(decodePlexImageRef(ref), '/library/metadata/1/art/2?width=1280');

  assert.throws(() => decodePlexImageRef('/library/metadata/1/thumb/2'), /reference/);
  assert.throws(
    () => decodePlexImageRef(encodeImageRef('plex', 'https://attacker.invalid/image.jpg')),
    /\/library\//
  );
  assert.throws(
    () => decodePlexImageRef(encodeImageRef('plex', '/:/prefs')),
    /\/library\//
  );
  assert.throws(
    () => decodePlexImageRef(encodeImageRef('plex', '/library/%2e%2e/:/prefs')),
    /\/library\/|Invalid Plex/
  );
  assert.throws(
    () => encodePlexImageRef('/library/metadata/1/thumb/2?X-Plex-Token=secret'),
    /credentials/
  );
});
