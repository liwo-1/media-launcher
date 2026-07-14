const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dataDir = path.join(os.tmpdir(), `media-launcher-agent-config-test-${process.pid}`);
process.env.DATA_DIR = dataDir;
delete process.env.PLAYER_AGENT_URL;
delete process.env.PLAYER_AGENT_SECRET;

const { readSettings, writeSettings } = require('../src/settings-store');
const { readAgentStore } = require('../src/agent-store');
const { pairPlayerAgent } = require('../src/agent-config');

const originalFetch = global.fetch;

function response(status, body = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

test('reports unconfigured without making a network request', async () => {
  global.fetch = () => assert.fail('fetch should not be called');

  const result = await pairPlayerAgent();

  assert.deepEqual(result, {
    paired: false,
    state: 'unconfigured',
    message: 'Save the player agent URL first.',
  });
});

test('generates, persists, and sends one key for first-time pairing', async () => {
  writeSettings({ playerAgentUrl: 'http://player.test:7777' });
  let sentSecret;
  global.fetch = async (url, options) => {
    if (url.endsWith('/health')) return response(200, { ok: true, paired: false });
    assert.equal(url, 'http://player.test:7777/pair');
    assert.equal(options.method, 'POST');
    sentSecret = JSON.parse(options.body).secret;
    return response(200, { paired: true });
  };

  const result = await pairPlayerAgent();

  assert.equal(result.paired, true);
  assert.equal(result.alreadyPaired, false);
  assert.match(sentSecret, /^[a-f0-9]{48}$/);
  assert.equal(readSettings().playerAgentSecret, sentSecret);
  assert.equal(readSettings().playerAgentPairingConfirmed, true);
  assert.equal(readAgentStore().agents[0].paired, true);
});

test('a lost first-pair response leaves a retryable pending agent and key', async () => {
  writeSettings({ playerAgentUrl: 'http://player.test:7777' });
  global.fetch = async (url) => {
    if (url.endsWith('/health')) return response(200, { ok: true, paired: false });
    const error = new Error('connection closed');
    error.name = 'TypeError';
    throw error;
  };

  await assert.rejects(pairPlayerAgent(), /Could not reach the player agent/);
  const settings = readSettings();
  const pending = readAgentStore().agents[0];
  assert.match(settings.playerAgentSecret, /^[a-f0-9]{48}$/);
  assert.equal(settings.playerAgentPairingConfirmed, false);
  assert.equal(pending.secret, settings.playerAgentSecret);
  assert.equal(pending.paired, false);
});

test('keeps an existing working key without calling the pairing endpoint', async () => {
  const secret = 'a'.repeat(48);
  writeSettings({ playerAgentUrl: 'http://player.test:7777', playerAgentSecret: secret });
  let calls = 0;
  global.fetch = async (url, options) => {
    calls++;
    if (url.endsWith('/health')) return response(200, { ok: true, paired: true });
    assert.equal(url, 'http://player.test:7777/status');
    assert.equal(options.headers.Authorization, `Bearer ${secret}`);
    return response(502, { error: 'MPC-HC is not running' });
  };

  const result = await pairPlayerAgent();

  assert.equal(calls, 2);
  assert.equal(result.paired, true);
  assert.equal(result.alreadyPaired, true);
  assert.equal(readSettings().playerAgentSecret, secret);
});

test('does not replace a key when the agent reports it is already paired', async () => {
  const secret = 'b'.repeat(48);
  writeSettings({ playerAgentUrl: 'http://player.test:7777', playerAgentSecret: secret });
  const urls = [];
  global.fetch = async (url) => {
    urls.push(url);
    if (url.endsWith('/health')) return response(200, { ok: true, paired: true });
    return response(401, { error: 'incorrect token' });
  };

  await assert.rejects(pairPlayerAgent(), /Reset pairing in its Windows Settings/);
  assert.deepEqual(urls, [
    'http://player.test:7777/health',
    'http://player.test:7777/status',
  ]);
  assert.equal(readSettings().playerAgentSecret, secret);
});

test('does not create a replacement key for an already-paired agent after an add-on reinstall', async () => {
  writeSettings({ playerAgentUrl: 'http://player.test:7777' });
  global.fetch = async (url) => {
    assert.equal(url, 'http://player.test:7777/health');
    return response(200, { ok: true, paired: true });
  };

  await assert.rejects(pairPlayerAgent(), /already paired.*Reset pairing/);
  assert.equal(readSettings().playerAgentSecret, '');
});
