'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dataDir = path.join(os.tmpdir(), `media-launcher-plex-auth-test-${process.pid}`);
process.env.DATA_DIR = dataDir;

const plexAuth = require('../src/plex-auth');
const { writeSettings } = require('../src/settings-store');
const { getStoredToken } = require('../src/token-store');

test.beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  plexAuth._test.pendingPins.clear();
});

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('environment-managed Plex credentials cannot be unlinked at runtime', (t) => {
  const originalToken = process.env.PLEX_TOKEN;
  process.env.PLEX_TOKEN = 'environment-token';
  t.after(() => {
    if (originalToken === undefined) delete process.env.PLEX_TOKEN;
    else process.env.PLEX_TOKEN = originalToken;
  });

  assert.throws(
    () => plexAuth.unlink(),
    (error) => error.status === 409 && /environment variables/.test(error.message)
  );
});

test('whitespace-only Plex environment credentials do not disable unlink', (t) => {
  const originalToken = process.env.PLEX_TOKEN;
  process.env.PLEX_TOKEN = '   ';
  t.after(() => {
    if (originalToken === undefined) delete process.env.PLEX_TOKEN;
    else process.env.PLEX_TOKEN = originalToken;
  });

  assert.doesNotThrow(() => plexAuth.unlink());
});

test('rejects a changed URL during linking and scopes a fresh Plex token exactly', async (t) => {
  const originalToken = process.env.PLEX_TOKEN;
  const originalUrl = process.env.PLEX_URL;
  delete process.env.PLEX_TOKEN;
  delete process.env.PLEX_URL;
  t.after(() => {
    if (originalToken === undefined) delete process.env.PLEX_TOKEN;
    else process.env.PLEX_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.PLEX_URL;
    else process.env.PLEX_URL = originalUrl;
  });
  writeSettings({ plexUrl: 'http://plex-a.local:32400/' });

  const realFetch = global.fetch;
  let issued = 122;
  global.fetch = async (url, options) => {
    assert.equal(options.redirect, 'manual');
    if (String(url) === 'https://plex.tv/api/v2/pins') {
      issued += 1;
      return new Response(JSON.stringify({ id: issued, code: 'ABCD', expiresIn: 600 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    assert.match(String(url), /^https:\/\/plex\.tv\/api\/v2\/pins\/12[34]$/);
    return new Response(JSON.stringify({ authToken: 'linked-private-token' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  t.after(() => { global.fetch = realFetch; });

  assert.deepEqual(await plexAuth.requestPin(), {
    id: '123',
    code: 'ABCD',
    expiresIn: 600,
  });
  writeSettings({ plexUrl: 'http://plex-b.local:32400' });
  await assert.rejects(
    plexAuth.checkPin('123'),
    (error) => error.status === 409 && /URL changed/.test(error.message)
  );
  assert.equal(getStoredToken('http://plex-a.local:32400'), null);
  assert.equal(getStoredToken('http://plex-b.local:32400'), null);

  writeSettings({ plexUrl: 'http://plex-a.local:32400' });
  assert.equal((await plexAuth.requestPin()).id, '124');
  assert.deepEqual(await plexAuth.checkPin('124'), { linked: true });
  assert.equal(getStoredToken('http://plex-a.local:32400'), 'linked-private-token');
  assert.equal(getStoredToken('http://plex-b.local:32400'), null);
});

test('refuses to poll a Plex PIN that was not issued by this process', async () => {
  await assert.rejects(
    plexAuth.checkPin('999'),
    (error) => error.status === 400 && /unknown/.test(error.message)
  );
});

test('unlink cancels an in-flight Plex PIN check before it can restore a token', async (t) => {
  const originalToken = process.env.PLEX_TOKEN;
  const originalUrl = process.env.PLEX_URL;
  delete process.env.PLEX_TOKEN;
  delete process.env.PLEX_URL;
  t.after(() => {
    if (originalToken === undefined) delete process.env.PLEX_TOKEN;
    else process.env.PLEX_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.PLEX_URL;
    else process.env.PLEX_URL = originalUrl;
  });
  writeSettings({ plexUrl: 'http://plex.local:32400' });

  const realFetch = global.fetch;
  let releaseCheck;
  let markCheckStarted;
  const checkStarted = new Promise((resolve) => { markCheckStarted = resolve; });
  const checkResponse = new Promise((resolve) => { releaseCheck = resolve; });
  global.fetch = async (url) => {
    if (String(url) === 'https://plex.tv/api/v2/pins') {
      return new Response(JSON.stringify({ id: 200, code: 'EFGH', expiresIn: 600 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    assert.equal(String(url), 'https://plex.tv/api/v2/pins/200');
    markCheckStarted();
    return checkResponse;
  };
  t.after(() => { global.fetch = realFetch; });

  await plexAuth.requestPin();
  const check = plexAuth.checkPin('200');
  await checkStarted;
  plexAuth.unlink();
  releaseCheck(new Response(JSON.stringify({ authToken: 'must-not-be-restored' }), {
    headers: { 'Content-Type': 'application/json' },
  }));

  await assert.rejects(
    check,
    (error) => error.status === 409 && /cancelled/.test(error.message)
  );
  assert.equal(getStoredToken('http://plex.local:32400'), null);
});

test('unlink also cancels a Plex PIN request that has not returned yet', async (t) => {
  const originalToken = process.env.PLEX_TOKEN;
  const originalUrl = process.env.PLEX_URL;
  delete process.env.PLEX_TOKEN;
  delete process.env.PLEX_URL;
  t.after(() => {
    if (originalToken === undefined) delete process.env.PLEX_TOKEN;
    else process.env.PLEX_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.PLEX_URL;
    else process.env.PLEX_URL = originalUrl;
  });
  writeSettings({ plexUrl: 'http://plex.local:32400' });

  const realFetch = global.fetch;
  let releaseRequest;
  let markRequestStarted;
  const requestStarted = new Promise((resolve) => { markRequestStarted = resolve; });
  const requestResponse = new Promise((resolve) => { releaseRequest = resolve; });
  global.fetch = async (url) => {
    assert.equal(String(url), 'https://plex.tv/api/v2/pins');
    markRequestStarted();
    return requestResponse;
  };
  t.after(() => { global.fetch = realFetch; });

  const request = plexAuth.requestPin();
  await requestStarted;
  plexAuth.unlink();
  releaseRequest(new Response(JSON.stringify({ id: 201, code: 'IJKL', expiresIn: 600 }), {
    headers: { 'Content-Type': 'application/json' },
  }));

  await assert.rejects(
    request,
    (error) => error.status === 409 && /cancelled/.test(error.message)
  );
  assert.equal(plexAuth._test.pendingPins.size, 0);
});
