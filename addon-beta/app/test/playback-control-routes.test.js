'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dataDir = path.join(os.tmpdir(), `media-launcher-control-route-test-${process.pid}`);
process.env.DATA_DIR = dataDir;

const { createApp } = require('../server');
const { targetId, writeAgentStore } = require('../src/agent-store');
const { _test: playbackMonitor } = require('../src/playback-monitor');

const instanceId = '3'.repeat(32);
const secret = 's'.repeat(48);

function storedAgent({ protocolVersion = 2, capabilities = [] } = {}) {
  return {
    instanceId,
    name: 'Living Room',
    url: 'http://living-room-agent:7777',
    secret,
    platform: 'windows',
    architecture: 'x64',
    negotiatedProtocolVersion: protocolVersion,
    players: [{
      id: 'vlc',
      name: 'VLC',
      kind: 'vlc',
      available: true,
      capabilities: ['play.file', ...capabilities],
    }],
    pathMap: [],
  };
}

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

async function command(base, sessionId, body) {
  return fetch(`${base}/api/playback-sessions/${sessionId}/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('control API securely translates a target command to the unified v2 agent endpoint', async (t) => {
  const base = await startServer(t);
  writeAgentStore({
    agents: [storedAgent({ capabilities: ['control.pause', 'control.seek', 'control.stop'] })],
  });
  const selectedTargetId = targetId(instanceId, 'vlc');
  const realFetch = global.fetch;
  let upstream;
  global.fetch = async (url, options) => {
    if (String(url).startsWith(base)) return realFetch(url, options);
    upstream = { url: String(url), options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      sessionId: 'session-1',
      action: 'seek',
      state: 'seeking',
      positionMs: 90000,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  t.after(() => { global.fetch = realFetch; });

  const response = await command(base, 'session-1', {
    targetId: selectedTargetId,
    action: 'seek',
    positionMs: 90000,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    sessionId: 'session-1',
    action: 'seek',
    state: 'seeking',
    positionMs: 90000,
  });
  assert.equal(upstream.url, 'http://living-room-agent:7777/v2/sessions/session-1/control');
  assert.equal(upstream.options.method, 'POST');
  assert.equal(upstream.options.headers.Authorization, `Bearer ${secret}`);
  assert.deepEqual(upstream.body, { action: 'seek', positionMs: 90000 });
  assert.equal(Object.hasOwn(upstream.body, 'targetId'), false);
});

test('a successful stop command finalizes only its matching playback monitor', async (t) => {
  const base = await startServer(t);
  writeAgentStore({
    agents: [storedAgent({ capabilities: ['control.stop'] })],
  });
  const selectedTargetId = targetId(instanceId, 'vlc');
  const providerUpdates = { progress: [], watched: [] };
  const session = playbackMonitor.createSession(
    {
      item: { id: 'movie-1', provider: 'plex', kind: 'movie', title: 'Movie' },
      sourcePath: '/media/movie.mkv',
      resumePositionMs: 0,
      context: { provider: 'plex', itemId: 'movie-1', kind: 'movie' },
    },
    {
      kind: 'plex',
      reportProgress: async (...args) => providerUpdates.progress.push(args),
      setWatched: async (...args) => providerUpdates.watched.push(args),
    },
    {
      id: selectedTargetId,
      agent: {
        instanceId,
        name: 'Living Room',
        platform: 'windows',
        secret,
      },
      player: { name: 'VLC', capabilities: ['play.file', 'control.stop'] },
    },
    { sessionId: 'session-1', protocolVersion: 2 }
  );
  session.seenActive = true;
  session.lastState = 'playing';
  session.lastPositionMs = 90;
  session.lastDurationMs = 100;
  session.lastFraction = 0.9;
  playbackMonitor.setCurrentSession(session);
  t.after(() => playbackMonitor.endSession(session));

  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).startsWith(base)) return realFetch(url, options);
    if (!options?.method || options.method === 'GET') {
      return new Response(JSON.stringify({
        sessionId: 'session-1',
        file: '',
        state: 'stopped',
        positionMs: 96,
        durationMs: 100,
        endReason: 'stopped-by-request',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      sessionId: 'session-1',
      action: 'stop',
      state: 'stopped',
      endReason: 'stopped-by-request',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  t.after(() => { global.fetch = realFetch; });

  const response = await command(base, 'session-1', {
    targetId: selectedTargetId,
    action: 'stop',
  });

  assert.equal(response.status, 200);
  assert.equal(session.cancelled, true);
  assert.equal(playbackMonitor.getCurrentSession(selectedTargetId), null);
  assert.equal(providerUpdates.progress.at(-1)[1].state, 'stopped');
  assert.equal(providerUpdates.progress.at(-1)[1].positionMs, 96);
  assert.equal(providerUpdates.watched.length, 1);
});

test('playback session inventory exposes only the sanitized control-card contract', async (t) => {
  const base = await startServer(t);
  const session = playbackMonitor.createSession(
    {
      item: { id: 'private-id', provider: 'plex', kind: 'movie', title: 'Example movie' },
      sourcePath: '/private/media/movie.mkv',
      resumePositionMs: 0,
      context: { provider: 'plex', itemId: 'private-id', kind: 'movie' },
    },
    { kind: 'plex', secret: 'provider-secret' },
    {
      id: 'target-public',
      agent: {
        instanceId,
        name: 'Living Room',
        platform: 'windows',
        secret: 'agent-secret',
      },
      player: {
        name: 'VLC',
        capabilities: ['play.file', 'status.state', 'control.pause', 'control.stop'],
      },
    },
    { sessionId: 'session-public', protocolVersion: 2 },
    '/private/media/movie.mkv'
  );
  playbackMonitor.setCurrentSession(session);
  t.after(() => playbackMonitor.endSession(session));

  const response = await fetch(`${base}/api/playback-sessions`);
  const body = await response.json();
  const serialized = JSON.stringify(body);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(body.sessions[0], {
    agentId: body.sessions[0].agentId,
    targetId: 'target-public',
    sessionId: 'session-public',
    title: 'Example movie',
    provider: 'plex',
    agentName: 'Living Room',
    playerName: 'VLC',
    capabilities: ['control.pause', 'control.stop'],
    state: 'starting',
    positionMs: 0,
    durationMs: 0,
  });
  assert.match(body.sessions[0].agentId, /^agent-[a-f0-9]{24}$/);
  assert.doesNotMatch(serialized, /private-id|private\/media|provider-secret|agent-secret/);
});

test('control API validates commands before contacting an agent', async (t) => {
  const base = await startServer(t);
  writeAgentStore({
    agents: [storedAgent({ capabilities: ['control.pause', 'control.seek', 'control.stop'] })],
  });
  const selectedTargetId = targetId(instanceId, 'vlc');
  const realFetch = global.fetch;
  let upstreamCalls = 0;
  global.fetch = async (url, options) => {
    if (String(url).startsWith(base)) return realFetch(url, options);
    upstreamCalls += 1;
    throw new Error(`Unexpected upstream request: ${url}`);
  };
  t.after(() => { global.fetch = realFetch; });

  const invalidCases = [
    ['bad%20session', { targetId: selectedTargetId, action: 'pause' }, /sessionId/],
    ['session-1', { targetId: selectedTargetId, action: 'play' }, /action must be/],
    ['session-1', { targetId: selectedTargetId, action: 'seek' }, /positionMs/],
    ['session-1', { targetId: selectedTargetId, action: 'seek', positionMs: -1 }, /positionMs/],
    ['session-1', { targetId: selectedTargetId, action: 'seek', positionMs: 1.5 }, /positionMs/],
    ['session-1', { targetId: selectedTargetId, action: 'pause', positionMs: 0 }, /only valid for seek/],
    ['session-1', { targetId: selectedTargetId, action: 'stop', extra: true }, /Unexpected/],
    ['session-1', { targetId: 'target-not-valid', action: 'stop' }, /targetId/],
  ];
  for (const [sessionId, body, errorPattern] of invalidCases) {
    const response = await command(base, sessionId, body);
    assert.equal(response.status, 400, `${sessionId}: ${JSON.stringify(body)}`);
    assert.match((await response.json()).error, errorPattern);
  }
  assert.equal(upstreamCalls, 0);
});

test('control API enforces current protocol and player capabilities', async (t) => {
  const base = await startServer(t);
  const selectedTargetId = targetId(instanceId, 'vlc');
  const realFetch = global.fetch;
  let upstreamCalls = 0;
  global.fetch = async (url, options) => {
    if (String(url).startsWith(base)) return realFetch(url, options);
    upstreamCalls += 1;
    throw new Error(`Unexpected upstream request: ${url}`);
  };
  t.after(() => { global.fetch = realFetch; });

  writeAgentStore({
    agents: [storedAgent({ protocolVersion: 1, capabilities: ['control.pause'] })],
  });
  let response = await command(base, 'session-1', {
    targetId: selectedTargetId,
    action: 'pause',
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /protocol version 2/);

  writeAgentStore({ agents: [storedAgent()] });
  response = await command(base, 'session-1', {
    targetId: selectedTargetId,
    action: 'stop',
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /does not support stop/);

  response = await command(base, 'session-1', {
    targetId: targetId('4'.repeat(32), 'vlc'),
    action: 'stop',
  });
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /no longer exists/);
  assert.equal(upstreamCalls, 0);
});
