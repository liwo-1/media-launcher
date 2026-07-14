const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dataDir = path.join(os.tmpdir(), `media-launcher-playback-targets-test-${process.pid}`);
process.env.DATA_DIR = dataDir;

const { writeAgentStore } = require('../src/agent-store');
const { getPlaybackTargets } = require('../src/playback-targets');

const originalFetch = global.fetch;

function agent(instanceId, protocolVersion, secret) {
  return {
    instanceId,
    name: protocolVersion === 2 ? 'Living Room' : 'Bedroom',
    url: protocolVersion === 2 ? 'http://living-room:7777' : 'http://bedroom:7777',
    secret,
    paired: true,
    negotiatedProtocolVersion: protocolVersion,
    players: [{
      id: 'mpc-hc',
      name: 'MPC-HC',
      available: true,
      capabilities: ['play.file'],
    }],
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

test('probes each agent through an authenticated protocol endpoint', async () => {
  const v2Secret = 'a'.repeat(48);
  const v1Secret = 'b'.repeat(48);
  writeAgentStore({
    agents: [
      agent('1'.repeat(32), 2, v2Secret),
      agent('2'.repeat(32), 1, v1Secret),
    ],
  });
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, authorization: options.headers.Authorization });
    return url.includes('living-room')
      ? new Response('{}', { status: 200 })
      : new Response('{"error":"MPC not running"}', { status: 502 });
  };

  const result = await getPlaybackTargets();
  assert.deepEqual(requests, [
    { url: 'http://living-room:7777/v2/info', authorization: `Bearer ${v2Secret}` },
    { url: 'http://bedroom:7777/status', authorization: `Bearer ${v1Secret}` },
  ]);
  assert.equal(result.agents.every((entry) => entry.online), true);
  assert.equal(result.targets.every((entry) => entry.online), true);
});

test('does not call a healthy but unauthenticated endpoint online', async () => {
  writeAgentStore({ agents: [agent('3'.repeat(32), 2, 'c'.repeat(48))] });
  global.fetch = async () => new Response('{"error":"wrong key"}', { status: 401 });

  const result = await getPlaybackTargets();
  assert.equal(result.agents[0].online, false);
  assert.equal(result.targets[0].online, false);
});
