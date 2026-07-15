'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BrowserEvent,
  createBrowserHarness,
  flushMicrotasks,
  loadMediaLauncherApp,
} = require('./helpers/browser-harness');

function appHarness(options = {}) {
  return loadMediaLauncherApp(createBrowserHarness(options));
}

test('target picker disables offline players and resolves an explicit online choice', async () => {
  const harness = appHarness();
  const targets = [
    {
      id: 'living-room',
      name: 'Living room — VLC',
      platform: 'windows',
      online: false,
      capabilities: ['play.file'],
    },
    {
      id: 'bedroom',
      name: 'Bedroom — MPC-HC',
      platform: 'windows',
      online: true,
      capabilities: ['play.file', 'status.state', 'status.position', 'status.duration'],
    },
  ];
  harness.context.pickerTargets = targets;
  const selection = harness.evaluate(
    "showPlaybackTargetPicker(pickerTargets, 'bedroom')"
  );

  const dialog = harness.document.querySelector('dialog');
  assert.ok(dialog?.open);
  assert.equal(dialog.getAttribute('aria-labelledby'), dialog.querySelector('h2').id);
  const choices = dialog.querySelectorAll('button.target-option');
  assert.equal(choices.length, 2);
  assert.equal(choices[0].disabled, true);
  assert.match(choices[0].textContent, /Launch only/);
  assert.match(choices[1].textContent, /Default/);
  assert.match(choices[1].textContent, /Online/);

  choices[0].click();
  assert.ok(dialog.open, 'a disabled target cannot close the picker');
  choices[1].click();
  const selected = await selection;
  assert.equal(selected.id, 'bedroom');
  assert.equal(harness.document.querySelector('dialog'), null);
});

test('target picker cancel resolves without launching a player', async () => {
  const harness = appHarness();
  harness.context.pickerTargets = [{
    id: 'living-room',
    name: 'Living room — VLC',
    platform: 'windows',
    online: true,
    capabilities: ['play.file'],
  }];
  const selection = harness.evaluate(
    "showPlaybackTargetPicker(pickerTargets, '')"
  );
  const dialog = harness.document.querySelector('dialog');
  const cancel = dialog.querySelectorAll('button').find((button) => button.textContent === 'Cancel');
  cancel.click();
  assert.equal(await selection, null);
  assert.equal(dialog.isConnected, false);
});

test('target selection bypasses the dialog for one eligible online player', async () => {
  const onlyTarget = {
    id: 'living-room',
    name: 'Living room — VLC',
    platform: 'windows',
    online: true,
    capabilities: ['play.file'],
  };
  const harness = appHarness({
    api: {
      getPlaybackTargets: async () => ({
        targets: [onlyTarget],
        defaultPlaybackTargetId: '',
        alwaysAskPlaybackTarget: true,
      }),
    },
  });

  const selected = await harness.evaluate('selectPlaybackTarget()');
  assert.equal(selected.id, 'living-room');
  assert.equal(harness.document.querySelector('dialog'), null);
});

test('playback controls are capability-gated and send the exact session contract', async () => {
  const calls = [];
  const controlledTarget = {
    id: 'living-room',
    name: 'Living room — VLC',
    platform: 'windows',
    online: true,
    capabilities: ['play.file', 'control.pause', 'control.seek', 'control.stop'],
  };
  const harness = appHarness({
    api: {
      getPlaybackTargets: async () => ({ targets: [controlledTarget] }),
      play: async () => ({ targetId: controlledTarget.id, sessionId: 'session-1' }),
      controlPlaybackSession: async (sessionId, control) => {
        calls.push({ sessionId, ...control });
        return { ok: true };
      },
    },
  });

  await harness.evaluate("handlePlay('movie-1', 'Example movie')");
  const controls = harness.document.getElementById('playback-controls');
  assert.equal(controls.hidden, false);
  assert.match(controls.textContent, /Example movie/);
  const button = (label) => controls.querySelectorAll('button')
    .find((candidate) => candidate.textContent.includes(label));

  button('Pause').click();
  await flushMicrotasks();
  assert.deepEqual(calls[0], {
    sessionId: 'session-1',
    targetId: 'living-room',
    action: 'pause',
    positionMs: undefined,
  });
  assert.match(button('Resume').textContent, /Resume/);

  const seekInput = controls.querySelector('.playback-seek-input');
  seekInput.value = '90';
  button('Seek').click();
  await flushMicrotasks();
  assert.deepEqual(calls[1], {
    sessionId: 'session-1',
    targetId: 'living-room',
    action: 'seek',
    positionMs: 90000,
  });

  button('Stop').click();
  await flushMicrotasks();
  assert.equal(calls[2].action, 'stop');
  assert.equal(controls.hidden, true);
  assert.equal(controls.children.length, 0);
});

test('launch-only targets do not expose non-functional playback controls', async () => {
  const target = {
    id: 'custom-player',
    name: 'Office — Custom player',
    online: true,
    capabilities: ['play.file'],
  };
  const harness = appHarness({
    api: {
      getPlaybackTargets: async () => ({ targets: [target] }),
      play: async () => ({ targetId: target.id, sessionId: 'legacy-session' }),
    },
  });

  await harness.evaluate("handlePlay('movie-1', 'Example movie')");
  const controls = harness.document.getElementById('playback-controls');
  assert.equal(controls.hidden, true);
  assert.equal(controls.children.length, 0);
});

test('control cards coexist across agents and replace sessions on the same physical agent', () => {
  const harness = appHarness();
  const first = {
    id: 'living-room-vlc',
    agentId: 'agent-living-room',
    name: 'Living room — VLC',
    capabilities: ['play.file', 'control.stop'],
  };
  const second = {
    id: 'bedroom',
    agentId: 'agent-bedroom',
    name: 'Bedroom — VLC',
    capabilities: ['play.file', 'control.stop'],
  };
  const replacement = {
    id: 'living-room-mpc',
    agentId: 'agent-living-room',
    name: 'Living room — MPC-HC',
    capabilities: ['play.file', 'control.stop'],
  };
  harness.context.firstTarget = first;
  harness.context.secondTarget = second;
  harness.context.replacementTarget = replacement;
  harness.evaluate("showPlaybackSessionControls('First movie', firstTarget, { sessionId: 'one' })");
  harness.evaluate("showPlaybackSessionControls('Second movie', secondTarget, { sessionId: 'two' })");

  const controls = harness.document.getElementById('playback-controls');
  assert.equal(controls.querySelectorAll('article').length, 2);
  harness.evaluate(`showPlaybackSessionControls(
    'Replacement movie',
    replacementTarget,
    { sessionId: 'three' }
  )`);
  assert.equal(controls.querySelectorAll('article').length, 2);
  assert.doesNotMatch(controls.textContent, /First movie/);
  assert.match(controls.textContent, /Replacement movie/);
  assert.match(controls.textContent, /Second movie/);
});

test('session reconciliation follows auto-next and removes naturally completed playback', () => {
  const harness = appHarness();
  const controls = harness.document.getElementById('playback-controls');
  harness.context.sessions = {
    sessions: [{
      agentId: 'agent-living-room',
      targetId: 'target-vlc',
      sessionId: 'session-one',
      title: 'Episode one',
      agentName: 'Living room',
      playerName: 'VLC',
      capabilities: ['control.pause', 'control.stop'],
      state: 'playing',
    }],
  };
  harness.evaluate('reconcilePlaybackSessionCards(sessions)');

  assert.equal(controls.querySelectorAll('article').length, 1);
  assert.match(controls.textContent, /Episode one/);
  assert.equal(controls.querySelector('article').dataset.sessionId, 'session-one');

  harness.context.sessions = {
    sessions: [{
      agentId: 'agent-living-room',
      targetId: 'target-mpc',
      sessionId: 'session-two',
      title: 'Episode two',
      agentName: 'Living room',
      playerName: 'MPC-HC',
      capabilities: ['control.stop'],
      state: 'starting',
    }],
  };
  harness.evaluate('reconcilePlaybackSessionCards(sessions)');

  assert.equal(controls.querySelectorAll('article').length, 1);
  assert.doesNotMatch(controls.textContent, /Episode one/);
  assert.match(controls.textContent, /Episode two/);
  assert.match(controls.textContent, /Starting on Living room — MPC-HC/);
  assert.equal(controls.querySelector('article').dataset.sessionId, 'session-two');
  assert.equal(controls.querySelector('article').dataset.targetId, 'target-mpc');

  harness.context.sessions = { sessions: [] };
  harness.evaluate('reconcilePlaybackSessionCards(sessions)');
  assert.equal(controls.children.length, 0);
  assert.equal(controls.hidden, true);
});

test('dismissed controls stay hidden for that session but return for the next session', () => {
  const harness = appHarness();
  const controls = harness.document.getElementById('playback-controls');
  const session = {
    agentId: 'agent-living-room',
    targetId: 'target-vlc',
    sessionId: 'session-one',
    title: 'Episode one',
    agentName: 'Living room',
    playerName: 'VLC',
    capabilities: ['control.stop'],
    state: 'playing',
  };
  harness.context.sessions = { sessions: [session] };
  harness.evaluate('reconcilePlaybackSessionCards(sessions)');
  controls.querySelector('.playback-dismiss').click();
  harness.evaluate('reconcilePlaybackSessionCards(sessions)');
  assert.equal(controls.children.length, 0);

  harness.context.sessions = {
    sessions: [{ ...session, sessionId: 'session-two', title: 'Episode two' }],
  };
  harness.evaluate('reconcilePlaybackSessionCards(sessions)');
  assert.equal(controls.querySelectorAll('article').length, 1);
  assert.match(controls.textContent, /Episode two/);
});

test('newer library navigation wins when provider requests resolve out of order', async () => {
  let resolveOlder;
  let resolveNewer;
  const older = new Promise((resolve) => { resolveOlder = resolve; });
  const newer = new Promise((resolve) => { resolveNewer = resolve; });
  let calls = 0;
  const harness = appHarness({
    api: {
      getLibraries: () => calls++ === 0 ? older : newer,
    },
  });

  const olderBuild = harness.evaluate('buildNav()');
  const newerBuild = harness.evaluate('buildNav()');
  resolveNewer({ items: [{ id: 'new', kind: 'movie', title: 'New provider' }] });
  await newerBuild;
  resolveOlder({ items: [{ id: 'old', kind: 'movie', title: 'Old provider' }] });
  await olderBuild;

  const navigation = harness.document.getElementById('nav-libraries');
  assert.match(navigation.textContent, /New provider/);
  assert.doesNotMatch(navigation.textContent, /Old provider/);
  assert.equal(calls, 2, 'library data is fetched per navigation build, not globally cached');
});

test('API client encodes session ids and emits the exact control payload', async () => {
  const harness = createBrowserHarness();
  delete harness.context.api;
  const requests = [];
  harness.context.fetch = async (requestPath, options) => {
    requests.push({ requestPath, options });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  harness.load('api-client.js');

  await harness.evaluate(`api.controlPlaybackSession('session / one', {
    targetId: 'living-room',
    action: 'seek',
    positionMs: 90000,
  })`);
  assert.equal(requests[0].requestPath, 'api/playback-sessions/session%20%2F%20one/control');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    targetId: 'living-room',
    action: 'seek',
    positionMs: 90000,
  });

  await harness.evaluate(`api.controlPlaybackSession('session-two', {
    targetId: 'living-room',
    action: 'pause',
  })`);
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    targetId: 'living-room',
    action: 'pause',
  });

  await harness.evaluate('api.getPlaybackSessions()');
  assert.equal(requests[2].requestPath, 'api/playback-sessions');
  assert.equal(requests[2].options.method, undefined);
});

test('admin PIN stays in memory and only a tagged PIN challenge can prompt', async () => {
  const harness = createBrowserHarness();
  delete harness.context.api;
  const storage = new Map([['media-launcher-admin-pin', 'legacy-plaintext-pin']]);
  const storageCalls = [];
  harness.context.localStorage = {
    getItem(key) { storageCalls.push(['get', key]); return storage.get(key) || null; },
    setItem(key, value) { storageCalls.push(['set', key, value]); storage.set(key, value); },
    removeItem(key) { storageCalls.push(['remove', key]); storage.delete(key); },
  };
  let phase = 'provider-401';
  let requests = 0;
  let retryPin = '';
  harness.context.fetch = async (_path, options) => {
    requests += 1;
    if (phase === 'provider-401') {
      return new Response(JSON.stringify({ error: 'Provider session expired' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (requests === 2) {
      return new Response(JSON.stringify({
        error: 'Missing or incorrect admin PIN',
        adminPinRequired: true,
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    retryPin = options.headers.get('X-Admin-Pin');
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  harness.context.promptCalls = 0;
  harness.load('api-client.js');
  assert.equal(storage.has('media-launcher-admin-pin'), false);
  harness.evaluate(`api._requestAdminPin = async () => {
    promptCalls += 1;
    return '2468';
  }`);

  assert.equal(harness.evaluate('api._getStoredAdminPin()'), '');
  const providerFailure = await harness.evaluate("api._adminFetch('api/settings')");
  assert.equal(providerFailure.status, 401);
  assert.equal(harness.context.promptCalls, 0);

  phase = 'pin-challenge';
  const unlocked = await harness.evaluate("api._adminFetch('api/settings')");
  assert.equal(unlocked.status, 200);
  assert.equal(harness.context.promptCalls, 1);
  assert.equal(retryPin, '2468');
  assert.equal(harness.evaluate('api._getStoredAdminPin()'), '2468');
  assert.equal(storage.has('media-launcher-admin-pin'), false);
  assert.equal(storageCalls.some(([action]) => action === 'set'), false);
});

test('Settings renderer recovers after a failed render queue entry', async () => {
  const harness = appHarness({
    settingsRenders: [
      { error: new Error('temporary settings failure') },
      { title: 'Recovered settings' },
    ],
  });
  harness.window.location.hash = '#/settings';

  await harness.evaluate('router()');
  assert.equal(harness.document.querySelector('#app h1').textContent, 'Unable to load this page');
  assert.match(harness.document.querySelector('#app').textContent, /temporary settings failure/);

  await harness.evaluate('router()');
  assert.equal(harness.document.querySelector('#app h1').textContent, 'Recovered settings');
  assert.equal(harness.document.activeElement, harness.document.querySelector('#app h1'));
});

test('actual Settings view recovers after its API becomes available', async () => {
  let attempts = 0;
  const harness = createBrowserHarness({
    api: {
      getSettings: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Settings are temporarily unavailable');
        return {
          mediaProvider: 'plex',
          mediaProviderEnvironmentManaged: false,
          plexUrl: 'http://plex.local:32400',
          jellyfinUrl: '',
          mediaServer: {
            provider: 'plex',
            configured: true,
            authenticated: false,
            ready: false,
            capabilities: { scanLibrary: true },
          },
          mediaAccounts: {
            plex: {
              linked: false,
              serverUrl: 'http://plex.local:32400',
              urlEnvironmentManaged: false,
              credentialsEnvironmentManaged: false,
            },
            jellyfin: {
              linked: false,
              serverUrl: '',
              urlEnvironmentManaged: false,
              credentialsEnvironmentManaged: false,
            },
          },
          agents: [],
          pathMap: [],
          playerAgentUrl: '',
          defaultPlaybackTargetId: '',
          alwaysAskPlaybackTarget: true,
          adminPinConfigured: false,
        };
      },
      getPlaybackTargets: async () => ({ agents: [], targets: [] }),
    },
  });
  loadMediaLauncherApp(harness, { actualSettingsView: true });
  harness.window.location.hash = '#/settings';

  await harness.evaluate('router()');
  assert.match(harness.document.querySelector('#app').textContent, /temporarily unavailable/);
  assert.equal(harness.document.querySelector('#app [role="alert"]').textContent,
    'Settings are temporarily unavailable');

  await harness.evaluate('router()');
  assert.ok(harness.document.querySelector('#app .settings-view'));
  assert.equal(harness.document.querySelector('#app h1').textContent, 'Settings');
  assert.doesNotMatch(harness.document.querySelector('#app').textContent, /temporarily unavailable/);
  assert.equal(harness.document.activeElement, harness.document.querySelector('#app h1'));
});

test('Jellyfin credentials commit only after the current Settings flow confirms activation', async () => {
  const calls = [];
  let settingsReads = 0;
  const settings = {
    mediaProvider: 'jellyfin',
    mediaProviderEnvironmentManaged: false,
    plexUrl: '',
    jellyfinUrl: 'http://jellyfin.local:8096',
    mediaServer: {
      provider: 'jellyfin',
      configured: true,
      authenticated: false,
      ready: false,
      capabilities: { scanLibrary: false },
    },
    mediaAccounts: {
      plex: { linked: false, serverUrl: '' },
      jellyfin: {
        linked: false,
        serverUrl: 'http://jellyfin.local:8096',
        urlEnvironmentManaged: false,
        credentialsEnvironmentManaged: false,
      },
    },
    agents: [],
    pathMap: [],
    defaultPlaybackTargetId: '',
    alwaysAskPlaybackTarget: true,
    adminPinConfigured: false,
  };
  const harness = createBrowserHarness({
    api: {
      getSettings: async () => { settingsReads += 1; return settings; },
      getPlaybackTargets: async () => ({ agents: [], targets: [] }),
      getBootstrap: async () => ({
        mediaServer: {
          provider: 'jellyfin',
          authenticated: true,
          ready: true,
          capabilities: { scanLibrary: true },
        },
      }),
      loginJellyfin: async (credentials) => {
        calls.push(['login', credentials]);
        return { linked: true, linkId: 'pending-link-id' };
      },
      commitJellyfinLogin: async (linkId) => {
        calls.push(['commit', linkId]);
        return {
          linked: true,
          accountDisplayName: 'Movie User',
          serverName: 'Living Room Server',
          isAdministrator: true,
        };
      },
    },
  });
  loadMediaLauncherApp(harness, { actualSettingsView: true });
  harness.window.location.hash = '#/settings';
  await harness.evaluate('router()');
  const username = harness.document.querySelectorAll('input')
    .find((input) => input.autocomplete === 'username');
  const password = harness.document.querySelectorAll('input')
    .find((input) => input.autocomplete === 'current-password');
  assert.ok(username, `app=${harness.document.getElementById('app').textContent}; inputs: ${harness.document.querySelectorAll('input').map((input) => input.autocomplete || '').join(',')}`);
  assert.ok(password);
  username.value = 'Movie User';
  password.value = 'one-time-password';
  const signIn = harness.document.querySelectorAll('button')
    .find((button) => button.textContent === 'Sign in to Jellyfin');
  const discover = harness.document.querySelectorAll('button')
    .find((button) => button.textContent === 'Discover from media server');
  assert.equal(discover.disabled, true);

  signIn.click();
  await flushMicrotasks(12);

  assert.equal(settingsReads, 2, 'render plus secret-free PIN preflight');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['login', {
      serverUrl: 'http://jellyfin.local:8096',
      username: 'Movie User',
      password: 'one-time-password',
    }],
    ['commit', 'pending-link-id'],
  ]);
  assert.equal(password.value, '');
  assert.match(harness.document.querySelector('.media-server-account').textContent, /Linked as Movie User/);
  assert.equal(discover.disabled, false);
});

test('Plex activation failure stops polling and offers a credential-free retry', async () => {
  const calls = [];
  let activationAttempts = 0;
  const settings = {
    mediaProvider: 'plex',
    mediaProviderEnvironmentManaged: false,
    plexUrl: 'http://plex.local:32400',
    jellyfinUrl: '',
    mediaServer: {
      provider: 'plex',
      configured: true,
      authenticated: false,
      ready: false,
      capabilities: { scanLibrary: true },
    },
    mediaAccounts: {
      plex: {
        linked: false,
        serverUrl: 'http://plex.local:32400',
        urlEnvironmentManaged: false,
        credentialsEnvironmentManaged: false,
      },
      jellyfin: { linked: false, serverUrl: '' },
    },
    agents: [],
    pathMap: [],
    defaultPlaybackTargetId: '',
    alwaysAskPlaybackTarget: true,
    adminPinConfigured: false,
  };
  const harness = createBrowserHarness({
    api: {
      getSettings: async () => settings,
      getPlaybackTargets: async () => ({ agents: [], targets: [] }),
      getBootstrap: async () => ({
        mediaServer: { provider: 'plex', ready: true, capabilities: { scanLibrary: true } },
      }),
      saveSettings: async (patch) => {
        calls.push(['save', patch]);
        if (patch.mediaProvider === 'plex') {
          activationAttempts += 1;
          if (activationAttempts === 1) throw new Error('temporary settings failure');
        }
        return {};
      },
      requestPlexPin: async () => {
        calls.push(['request-pin']);
        return { id: '123', code: 'ABCD', expiresIn: 600 };
      },
      checkPlexPin: async () => {
        calls.push(['check-pin']);
        return { linked: true };
      },
    },
  });
  loadMediaLauncherApp(harness, { actualSettingsView: true });
  harness.window.location.hash = '#/settings';
  await harness.evaluate('router()');
  const link = harness.document.querySelectorAll('button')
    .find((button) => button.textContent === 'Link with Plex');
  assert.ok(link, `app=${harness.document.getElementById('app').textContent}; buttons: ${harness.document.querySelectorAll('button').map((button) => button.textContent).join('|')}`);
  link.click();
  await flushMicrotasks(12);

  const retry = harness.document.querySelectorAll('button')
    .find((button) => button.textContent === 'Retry activation');
  assert.ok(retry);
  assert.equal(retry.hidden, false);
  assert.match(harness.document.querySelector('.media-server-account').textContent,
    /setup could not finish/);
  assert.equal(calls.filter(([name]) => name === 'check-pin').length, 1);
  assert.equal(harness.timers.size, 0, 'a linked code is not polled again after activation fails');

  retry.click();
  await flushMicrotasks(12);
  assert.equal(activationAttempts, 2);
  assert.equal(calls.filter(([name]) => name === 'check-pin').length, 1);
  assert.match(harness.document.querySelector('.media-server-account').textContent, /Linked/);
});

test('stale Settings completion cannot replace the current recovery render', async () => {
  let releaseFirst;
  let markStarted;
  const firstStarted = new Promise((resolve) => { markStarted = resolve; });
  const firstWait = new Promise((resolve) => { releaseFirst = resolve; });
  const harness = appHarness({
    settingsRenders: [
      { title: 'Stale settings', wait: firstWait, started: markStarted },
      { title: 'Current settings' },
    ],
  });
  harness.window.location.hash = '#/settings';

  const firstRoute = harness.evaluate('router()');
  await firstStarted;
  const currentRoute = harness.evaluate('router()');
  releaseFirst();
  await Promise.all([firstRoute, currentRoute]);

  assert.equal(harness.document.querySelector('#app h1').textContent, 'Current settings');
  assert.doesNotMatch(harness.document.querySelector('#app').textContent, /Stale settings/);
});

test('provider recovery clears stale libraries and rebuilds them when ready', async () => {
  const state = { ready: false };
  const harness = appHarness({
    api: {
      getBootstrap: async () => ({ mediaServer: { ready: state.ready } }),
      getLibraries: async () => ({
        items: [{ id: 'movies', title: 'Recovered movies', kind: 'movie', canScan: false }],
      }),
    },
  });
  const nav = harness.document.getElementById('nav-libraries');
  const stale = harness.document.createElement('a');
  stale.textContent = 'Old provider library';
  nav.appendChild(stale);

  await harness.evaluate('refreshNavIfMediaReady()');
  assert.equal(nav.children.length, 0);

  state.ready = true;
  await harness.evaluate('refreshNavIfMediaReady()');
  assert.equal(nav.querySelector('a').textContent, 'Recovered movies');
  assert.equal(nav.querySelector('a').getAttribute('href'), '#/library/movies');
  assert.equal(nav.querySelector('a').href, '#/library/movies');
});

test('season tabs expose accessible relationships and preserve focus across activation', async () => {
  const seasons = [
    {
      id: 'season-1',
      title: 'Season 1',
      images: {},
      counts: { episodes: 1 },
      hierarchy: { seasonNumber: 1 },
    },
    {
      id: 'season-2',
      title: 'Season 2',
      images: {},
      counts: { episodes: 1 },
      hierarchy: { seasonNumber: 2 },
    },
  ];
  const harness = appHarness({
    api: {
      getItem: async () => ({
        id: 'show-1',
        kind: 'series',
        title: 'Example show',
        images: {},
        counts: { episodes: 2, watchedEpisodes: 0 },
      }),
      getSeasons: async () => ({ items: seasons }),
      getContinueWatching: async () => ({ items: [] }),
      getRelated: async () => ({ items: [] }),
      getEpisodes: async (_seriesId, seasonId) => ({
        items: [{
          id: `episode-${seasonId}`,
          kind: 'episode',
          title: `Episode from ${seasonId}`,
          images: {},
          hierarchy: { episodeNumber: 1 },
        }],
      }),
    },
  });

  await harness.evaluate("renderSeriesDetailView('show-1', startRoute())");
  await flushMicrotasks();
  let tablist = harness.document.querySelector('[role="tablist"]');
  let tabs = tablist.querySelectorAll('[role="tab"]');
  const panel = harness.document.getElementById('season-episode-panel');
  assert.equal(tablist.getAttribute('aria-labelledby'), 'season-tabs-heading');
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  assert.equal(tabs[0].tabIndex, 0);
  assert.equal(tabs[1].tabIndex, -1);
  assert.equal(panel.getAttribute('role'), 'tabpanel');
  assert.equal(panel.getAttribute('aria-labelledby'), tabs[0].id);

  tabs[0].focus();
  tabs[0].dispatchEvent(new BrowserEvent('keydown', {
    cancelable: true,
    key: 'ArrowRight',
  }));
  await flushMicrotasks();
  tablist = harness.document.querySelector('[role="tablist"]');
  tabs = tablist.querySelectorAll('[role="tab"]');
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(tabs[1].tabIndex, 0);
  assert.equal(harness.document.activeElement, tabs[1]);
  assert.equal(panel.getAttribute('aria-labelledby'), tabs[1].id);
  assert.equal(panel.hasAttribute('aria-busy'), false);
  assert.match(panel.textContent, /Episode from season-2/);

  tabs[1].dispatchEvent(new BrowserEvent('keydown', { cancelable: true, key: 'Home' }));
  await flushMicrotasks();
  tabs = harness.document.querySelector('[role="tablist"]').querySelectorAll('[role="tab"]');
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  assert.equal(harness.document.activeElement, tabs[0]);
});
