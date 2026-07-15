const assert = require('node:assert/strict');
const test = require('node:test');
const { joinServerPath, normalizeServerUrl, sameServerUrl } = require('../src/server-url');

test('normalizes root and base-path server URLs without losing the Jellyfin base path', () => {
  assert.equal(normalizeServerUrl(' http://host.test:8096/ '), 'http://host.test:8096');
  assert.equal(
    normalizeServerUrl('https://host.test/jellyfin///'),
    'https://host.test/jellyfin'
  );
  assert.equal(
    joinServerPath('https://host.test/jellyfin/', '/Users/Me'),
    'https://host.test/jellyfin/Users/Me'
  );
});

test('rejects credentials, non-http schemes, queries, and fragments', () => {
  assert.throws(() => normalizeServerUrl('ftp://host.test'), /http:\/\/ or https:\/\//);
  assert.throws(() => normalizeServerUrl('http://user:secret@host.test'), /credentials/);
  assert.throws(() => normalizeServerUrl('http://host.test/?token=secret'), /query or fragment/);
  assert.throws(() => normalizeServerUrl('http://host.test/#fragment'), /query or fragment/);
});

test('compares normalized server identity including the configured base path', () => {
  assert.equal(sameServerUrl('https://HOST.test/jellyfin/', 'https://host.test/jellyfin'), true);
  assert.equal(sameServerUrl('https://host.test/jellyfin', 'https://host.test/other'), false);
});
