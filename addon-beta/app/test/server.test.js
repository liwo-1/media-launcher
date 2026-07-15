'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dataDir = path.join(os.tmpdir(), `media-launcher-server-test-${process.pid}`);
process.env.DATA_DIR = dataDir;
delete process.env.MEDIA_PROVIDER;
delete process.env.PLEX_URL;
delete process.env.PLEX_TOKEN;
delete process.env.JELLYFIN_URL;
delete process.env.JELLYFIN_ACCESS_TOKEN;
delete process.env.JELLYFIN_USER_ID;

const { createApp } = require('../server');
const jellyfinAuthRoutes = require('../src/routes/jellyfin-auth');
const legacyPlex = require('../src/plex');
const { readSettings, writeSettings } = require('../src/settings-store');

async function startServer(t) {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const app = createApp();
  const server = await new Promise((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('public bootstrap reports readiness without requesting an admin PIN or leaking settings', async (t) => {
  const base = await startServer(t);
  const response = await fetch(`${base}/api/bootstrap`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body, {
    mediaServer: {
      provider: 'plex',
      label: 'Plex',
      configured: false,
      authenticated: false,
      ready: false,
      capabilities: {
        scanLibrary: true,
        search: true,
        watched: true,
        progress: true,
        related: true,
        directFile: true,
      },
    },
    playback: { hasTargets: false },
  });
  assert.doesNotMatch(JSON.stringify(body), /token|secret|password/i);
});

test('settings switch media provider with normalized URLs and keep credentials out of JSON', async (t) => {
  const base = await startServer(t);
  const response = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mediaProvider: 'jellyfin',
      jellyfinUrl: 'http://jellyfin.local:8096/base/',
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('vary') || '', /X-Admin-Pin/i);
  const settings = await response.json();
  assert.equal(settings.mediaProvider, 'jellyfin');
  assert.equal(settings.jellyfinUrl, 'http://jellyfin.local:8096/base');
  assert.equal(settings.mediaServer.provider, 'jellyfin');
  assert.equal(settings.mediaServer.configured, true);
  assert.equal(settings.mediaServer.authenticated, false);
  assert.equal(settings.mediaServer.serverUrl, 'http://jellyfin.local:8096/base');
  assert.doesNotMatch(JSON.stringify(settings), /accessToken|playerAgentSecret|password/i);

  const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
  assert.equal(bootstrap.mediaServer.provider, 'jellyfin');
  assert.equal(bootstrap.mediaServer.ready, false);
});

test('settings reject credential-bearing URLs and malformed JSON with JSON errors', async (t) => {
  const base = await startServer(t);
  const unsafe = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plexUrl: 'http://user:password@plex.local:32400' }),
  });
  assert.equal(unsafe.status, 400);
  assert.match((await unsafe.json()).error, /cannot contain credentials/);

  const malformed = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'Request body must contain valid JSON.' });
});

test('an invalid legacy server URL does not lock the user out of Settings recovery', async (t) => {
  const base = await startServer(t);
  writeSettings({
    mediaProvider: 'plex',
    plexUrl: 'legacy-plex-without-a-scheme:32400',
  });

  const bootstrap = await fetch(`${base}/api/bootstrap`);
  assert.equal(bootstrap.status, 200);
  assert.equal((await bootstrap.json()).mediaServer.ready, false);

  const response = await fetch(`${base}/api/settings`);
  assert.equal(response.status, 200);
  const settings = await response.json();
  assert.equal(settings.plexUrl, 'legacy-plex-without-a-scheme:32400');
  assert.equal(settings.mediaServer.ready, false);
});

test('protected routes fail closed when an existing settings file is corrupt', async (t) => {
  const base = await startServer(t);
  const configured = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newAdminPin: '2468' }),
  });
  assert.equal(configured.status, 200);

  const locked = await fetch(`${base}/api/settings`);
  assert.equal(locked.status, 401);
  fs.writeFileSync(path.join(dataDir, 'settings.json'), '{corrupt');

  const response = await fetch(`${base}/api/settings`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.match(body.error, /Settings storage is unavailable/);
  assert.equal(body.adminPinConfigured, undefined);

  for (const invalidHash of [false, null, 0]) {
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
      adminPinHash: invalidHash,
    }));
    const invalidSchema = await fetch(`${base}/api/settings`);
    assert.equal(invalidSchema.status, 503);
    assert.match((await invalidSchema.json()).error, /Settings storage is unavailable/);
  }
});

test('Jellyfin login keeps its token transient until the current UI commits activation', async (t) => {
  const base = await startServer(t);
  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).startsWith(base)) return realFetch(url, options);
    if (String(url) === 'http://jellyfin.test:8096/base/System/Info/Public') {
      return new Response(JSON.stringify({
        Id: 'server-1',
        ProductName: 'Jellyfin Server',
        ServerName: 'Test Server',
        Version: '10.11.11',
        StartupWizardCompleted: true,
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url) === 'http://jellyfin.test:8096/base/Users/AuthenticateByName') {
      assert.equal(JSON.parse(options.body).Pw, 'one-time-password');
      return new Response(JSON.stringify({
        AccessToken: 'stored-user-token',
        ServerId: 'server-1',
        User: {
          Id: 'user-1',
          Name: 'Movie User',
          Policy: { IsAdministrator: true },
        },
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  t.after(() => { global.fetch = realFetch; });

  const response = await fetch(`${base}/api/jellyfin-auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serverUrl: 'http://jellyfin.test:8096/base/',
      username: 'Movie User',
      password: 'one-time-password',
    }),
  });
  assert.equal(response.status, 200);
  const pending = await response.json();
  assert.deepEqual({ ...pending, linkId: '<opaque>' }, {
    linked: true,
    accountDisplayName: 'Movie User',
    serverName: 'Test Server',
    isAdministrator: true,
    linkId: '<opaque>',
  });
  assert.match(pending.linkId, /^[0-9a-f-]{36}$/i);
  const pendingEntry = jellyfinAuthRoutes._test.pendingLinks.get(pending.linkId);
  assert.ok(pendingEntry);
  assert.equal(pendingEntry.expiryTimer.hasRef?.(), false);

  const beforeCommit = fs.readFileSync(path.join(dataDir, 'jellyfin-auth.json'), 'utf8');
  assert.doesNotMatch(beforeCommit, /stored-user-token|one-time-password|"password"/i);
  const settings = readSettings();
  assert.equal(settings.mediaProvider, 'plex');
  assert.equal(settings.jellyfinUrl, '');

  const activate = await fetch(`${base}/api/jellyfin-auth/login/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ linkId: pending.linkId }),
  });
  assert.equal(activate.status, 200);
  assert.equal((await activate.json()).linked, true);
  assert.equal(jellyfinAuthRoutes._test.pendingLinks.has(pending.linkId), false);

  const stored = fs.readFileSync(path.join(dataDir, 'jellyfin-auth.json'), 'utf8');
  assert.match(stored, /stored-user-token/);
  assert.doesNotMatch(stored, /one-time-password|"password"/i);
  const activatedSettings = readSettings();
  assert.equal(activatedSettings.mediaProvider, 'jellyfin');
  assert.equal(activatedSettings.jellyfinUrl, 'http://jellyfin.test:8096/base');

  const browserSettings = await (await fetch(`${base}/api/settings`)).json();
  assert.equal(browserSettings.mediaAccounts.jellyfin.linked, true);
  assert.equal(browserSettings.mediaAccounts.jellyfin.accountDisplayName, 'Movie User');
  assert.doesNotMatch(JSON.stringify(browserSettings), /stored-user-token|one-time-password/);
});

test('unlink cancels an in-flight Jellyfin login before it can restore credentials', async (t) => {
  const base = await startServer(t);
  const realFetch = global.fetch;
  let markAuthenticationStarted;
  let releaseAuthentication;
  const authenticationStarted = new Promise((resolve) => { markAuthenticationStarted = resolve; });
  const authenticationResponse = new Promise((resolve) => { releaseAuthentication = resolve; });
  global.fetch = async (url, options) => {
    if (String(url).startsWith(base)) return realFetch(url, options);
    if (String(url) === 'http://jellyfin.test:8096/System/Info/Public') {
      return new Response(JSON.stringify({
        Id: 'server-1',
        ProductName: 'Jellyfin Server',
        ServerName: 'Test Server',
        Version: '10.11.11',
        StartupWizardCompleted: true,
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url) === 'http://jellyfin.test:8096/Users/AuthenticateByName') {
      assert.equal(JSON.parse(options.body).Pw, 'one-time-password');
      markAuthenticationStarted();
      return authenticationResponse;
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  t.after(() => { global.fetch = realFetch; });

  const login = fetch(`${base}/api/jellyfin-auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serverUrl: 'http://jellyfin.test:8096',
      username: 'Movie User',
      password: 'one-time-password',
    }),
  });
  await authenticationStarted;
  const unlink = await fetch(`${base}/api/jellyfin-auth/unlink`, { method: 'POST' });
  assert.equal(unlink.status, 200);
  releaseAuthentication(new Response(JSON.stringify({
    AccessToken: 'must-not-be-stored',
    ServerId: 'server-1',
    User: { Id: 'user-1', Name: 'Movie User', Policy: { IsAdministrator: false } },
  }), { headers: { 'Content-Type': 'application/json' } }));

  const loginResponse = await login;
  assert.equal(loginResponse.status, 409);
  const stored = fs.readFileSync(path.join(dataDir, 'jellyfin-auth.json'), 'utf8');
  assert.doesNotMatch(stored, /must-not-be-stored|one-time-password/);
});

test('legacy Plex endpoints return 409 while provider-neutral playback routes remain active', async (t) => {
  const base = await startServer(t);
  const configured = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mediaProvider: 'jellyfin',
      jellyfinUrl: 'http://jellyfin.test:8096',
    }),
  });
  assert.equal(configured.status, 200);

  const legacyRequests = [
    ['GET', '/api/libraries'],
    ['GET', '/api/items?parentId=library-1'],
    ['GET', '/api/libraries/library-1/recentlyAdded'],
    ['GET', '/api/items/item-1'],
    ['GET', '/api/items/item-1/related'],
    ['GET', '/api/shows/show-1/seasons'],
    ['GET', '/api/shows/show-1/seasons/season-1/episodes'],
    ['POST', '/api/libraries/library-1/scan'],
    ['GET', '/api/ondeck'],
    ['POST', '/api/items/item-1/watched'],
    ['POST', '/api/items/item-1/unwatched'],
    ['GET', '/api/image?path=%2Flibrary%2Fmetadata%2Fitem-1%2Fthumb%2Ftag'],
  ];
  const expectedError = {
    error: 'This legacy Plex endpoint is unavailable while Jellyfin is active. Use /api/media instead.',
  };
  for (const [method, requestPath] of legacyRequests) {
    const response = await fetch(`${base}${requestPath}`, { method });
    assert.equal(response.status, 409, `${method} ${requestPath}`);
    assert.deepEqual(await response.json(), expectedError, `${method} ${requestPath}`);
  }

  const targets = await fetch(`${base}/api/playback-targets`);
  assert.equal(targets.status, 200);

  const play = await fetch(`${base}/api/play/item-1`, { method: 'POST' });
  assert.equal(play.status, 401);
  assert.match((await play.json()).error, /Jellyfin account is not linked/);
});

test('legacy artwork compatibility cannot traverse Plex APIs or stream non-images', async (t) => {
  const base = await startServer(t);
  const configured = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plexUrl: 'http://plex.test:32400' }),
  });
  assert.equal(configured.status, 200);
  legacyPlex.setToken('private-legacy-token');

  const realFetch = global.fetch;
  const upstreamCalls = [];
  global.fetch = async (url, options) => {
    if (String(url).startsWith(base)) return realFetch(url, options);
    upstreamCalls.push({ url: String(url), options });
    return new Response(JSON.stringify({ private: 'metadata' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  t.after(() => {
    global.fetch = realFetch;
    legacyPlex.setToken(null);
  });

  for (const pathValue of ['/library/../status/sessions', '/library/%2e%2e/status/sessions']) {
    const response = await fetch(
      `${base}/api/image?${new URLSearchParams({ path: pathValue })}`
    );
    assert.equal(response.status, 400);
  }
  assert.equal(upstreamCalls.length, 0, 'traversal is rejected before any authenticated fetch');

  const nonImage = await fetch(
    `${base}/api/image?${new URLSearchParams({ path: '/library/metadata/1/thumb/2' })}`
  );
  assert.equal(nonImage.status, 502);
  assert.deepEqual(await nonImage.json(), { error: 'Plex returned invalid artwork' });
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].options.redirect, 'manual');
  assert.equal(upstreamCalls[0].options.headers['X-Plex-Token'], 'private-legacy-token');
});
