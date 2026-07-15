'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../src/routes/api');

test('legacy Plex compatibility payloads recursively omit provider source paths', () => {
  const raw = {
    title: 'Example',
    Location: [{ path: '/private/library/Movies' }],
    Media: [{
      Part: [{
        file: '/private/library/Movies/Example.mkv',
        key: '/library/parts/1/file.mkv',
        Stream: [{ language: 'eng' }],
      }],
    }],
  };

  const redacted = _test.redactLegacyPlex(raw);

  assert.equal(redacted.title, 'Example');
  assert.equal(redacted.Media[0].Part[0].key, '/library/parts/1/file.mkv');
  assert.equal(redacted.Media[0].Part[0].Stream[0].language, 'eng');
  assert.doesNotMatch(JSON.stringify(redacted), /private\/library|"file"|"path"/i);
  assert.equal(raw.Media[0].Part[0].file, '/private/library/Movies/Example.mkv');
});
