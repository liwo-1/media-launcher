const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dataDir = path.join(os.tmpdir(), `media-launcher-agent-client-test-${process.pid}`);
process.env.DATA_DIR = dataDir;

const { writeSettings } = require('../src/settings-store');
const { findTargetById, targetId, writeAgentStore } = require('../src/agent-store');
const { createSession, getSessionStatus, resolvePlaybackTarget } = require('../src/agent-client');

const originalFetch = global.fetch;
const firstId = '1'.repeat(32);
const secondId = '2'.repeat(32);

function agent(instanceId, url, secret, protocolVersion = 2) {
  return {
    instanceId,
    name: instanceId === firstId ? 'Living Room' : 'Bedroom',
    url,
    secret,
    platform: 'windows',
    architecture: 'x64',
    negotiatedProtocolVersion: protocolVersion,
    players: [{
      id: 'mpc-hc',
      name: 'MPC-HC',
      kind: 'mpc-hc',
      available: true,
      capabilities: ['play.file', 'status.state', 'status.position', 'status.duration'],
    }],
    pathMap: [],
  };
}

test.beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  global.fetch = originalFetch;
});

test.after(() => {
  global.fetch = originalFetch;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('dispatches a v2 session to the selected agent with its isolated bearer key', async () => {
  const secret = 'a'.repeat(48);
  const first = agent(firstId, 'http://living-room:7777', secret);
  writeAgentStore({ agents: [first] });
  const selected = findTargetById(targetId(firstId, 'mpc-hc'));
  let captured;
  global.fetch = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ sessionId: 'session-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await createSession(selected, { path: '\\\\nas\\Movies\\Film.mkv', title: 'Film' });

  assert.equal(captured.url, 'http://living-room:7777/v2/sessions');
  assert.equal(captured.options.headers.Authorization, `Bearer ${secret}`);
  assert.equal(captured.body.playerId, 'mpc-hc');
  assert.equal(captured.body.media.path, '\\\\nas\\Movies\\Film.mkv');
  assert.equal(result.sessionId, 'session-1');
});

test('retries one lost v2 launch response with the same request id', async () => {
  const first = agent(firstId, 'http://living-room:7777', 'a'.repeat(48));
  writeAgentStore({ agents: [first] });
  const selected = findTargetById(targetId(firstId, 'mpc-hc'));
  const requestIds = [];
  global.fetch = async (_url, options) => {
    requestIds.push(JSON.parse(options.body).requestId);
    if (requestIds.length === 1) throw new TypeError('connection reset');
    return new Response(JSON.stringify({ sessionId: 'session-recovered' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await createSession(selected, { path: '\\\\nas\\Movies\\Film.mkv' });
  assert.equal(result.sessionId, 'session-recovered');
  assert.equal(requestIds.length, 2);
  assert.equal(requestIds[0], requestIds[1]);
});

test('status polling follows an authenticated agent address refresh', async () => {
  const first = agent(firstId, 'http://old-address:7777', 'a'.repeat(48));
  writeAgentStore({ agents: [first] });
  const selected = findTargetById(targetId(firstId, 'mpc-hc'));
  first.url = 'http://new-address:7777';
  writeAgentStore({ agents: [first] });
  let requestedUrl;
  global.fetch = async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify({ state: 'playing', positionMs: 1, durationMs: 2 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await getSessionStatus(selected, 'session-1', 2);
  assert.equal(requestedUrl, 'http://new-address:7777/v2/sessions/session-1');
});

test('does not silently re-pair a reset managed agent after a 503', async () => {
  const first = agent(firstId, 'http://living-room:7777', 'a'.repeat(48));
  writeAgentStore({ agents: [first] });
  const selected = findTargetById(targetId(firstId, 'mpc-hc'));
  const urls = [];
  global.fetch = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify({ error: 'unpaired' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await assert.rejects(createSession(selected, { path: '\\\\nas\\Film.mkv' }), /unpaired/);
  assert.deepEqual(urls, ['http://living-room:7777/v2/sessions']);
});

test('uses an explicit default but never silently chooses among multiple targets without one', () => {
  writeAgentStore({
    agents: [
      agent(firstId, 'http://living-room:7777', 'a'.repeat(48)),
      agent(secondId, 'http://bedroom:7777', 'b'.repeat(48)),
    ],
  });
  assert.throws(() => resolvePlaybackTarget(), /Choose a playback target/);

  const preferredId = targetId(secondId, 'mpc-hc');
  writeSettings({ defaultPlaybackTargetId: preferredId });
  const preferred = resolvePlaybackTarget();
  assert.equal(preferred.agent.instanceId, secondId);
});

test('rejects a stale explicit target instead of falling back to another room', () => {
  writeAgentStore({ agents: [agent(firstId, 'http://living-room:7777', 'a'.repeat(48))] });
  assert.throws(
    () => resolvePlaybackTarget('target-does-not-exist'),
    /selected playback target no longer exists/
  );
});

test('does not fall back to the sole remaining room when the configured default is stale', () => {
  writeAgentStore({ agents: [agent(firstId, 'http://living-room:7777', 'a'.repeat(48))] });
  writeSettings({ defaultPlaybackTargetId: targetId(secondId, 'mpc-hc') });
  assert.throws(
    () => resolvePlaybackTarget(),
    /configured default playback target is unavailable/
  );
});
