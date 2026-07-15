'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dataDir = path.join(os.tmpdir(), `media-launcher-protocol-fixture-test-${process.pid}`);
process.env.DATA_DIR = dataDir;

const { createSession, getSessionStatus } = require('../src/agent-client');
const { registerPlayerAgent } = require('../src/agent-registration');
const { findTargetById, targetId, writeAgentStore } = require('../src/agent-store');

const fixtureDirectory = path.resolve(__dirname, '..', '..', '..', 'protocol', 'fixtures');
const originalFetch = global.fetch;

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDirectory, name), 'utf8'));
}

function assertRegistrationResponse(actual, expected) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  assert.equal(actual.paired, expected.paired);
  assert.equal(actual.secret, expected.secret);
  assert.equal(actual.playerAgentUrl, expected.playerAgentUrl);
  assert.equal(actual.protocolVersion, expected.protocolVersion);
  assert.equal(actual.selectedProtocolVersion, expected.selectedProtocolVersion);
  assert.equal(actual.registrationRefreshSeconds, expected.registrationRefreshSeconds);
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

test('keeps the released protocol-v1 registration fixture compatible', () => {
  const body = fixture('registration-v1.json');
  const expected = fixture('registration-response-v1.json');
  const result = registerPlayerAgent({
    body,
    remoteAddress: '192.0.2.10',
    authorization: `Bearer ${expected.secret}`,
  });

  assert.equal(result.status, 200);
  assertRegistrationResponse(result.body, expected);
});

test('negotiates protocol v2 from the additive current-agent fixture', () => {
  const body = fixture('registration-v2-capable.json');
  const expected = fixture('registration-response-v2.json');
  const result = registerPlayerAgent({
    body,
    remoteAddress: '192.0.2.11',
    authorization: `Bearer ${expected.secret}`,
  });

  assert.equal(result.status, 200);
  assertRegistrationResponse(result.body, expected);
  const target = findTargetById(targetId(body.instanceId, body.players[0].id));
  assert.equal(target.agent.negotiatedProtocolVersion, 2);
  assert.deepEqual(target.player.capabilities, body.players[0].capabilities);
});

test('keeps protocol-v2 session request and status wire fields stable', async () => {
  const registration = fixture('registration-v2-capable.json');
  const expectedRequest = fixture('session-create-v2.json');
  const statusFixture = fixture('session-status-v2.json');
  const secret = fixture('registration-response-v2.json').secret;
  writeAgentStore({
    agents: [{
      instanceId: registration.instanceId,
      name: registration.displayName,
      advertisedName: registration.displayName,
      url: 'http://192.0.2.11:7777',
      secret,
      paired: true,
      platform: registration.platform,
      architecture: registration.architecture,
      negotiatedProtocolVersion: 2,
      players: registration.players,
      pathMap: [],
    }],
  });
  const selected = findTargetById(targetId(registration.instanceId, expectedRequest.playerId));
  let capturedRequest;
  global.fetch = async (url, options = {}) => {
    if (options.method === 'POST') {
      capturedRequest = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        sessionId: statusFixture.sessionId,
        playerId: statusFixture.playerId,
        state: 'starting',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify(statusFixture), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const launched = await createSession(selected, {
    path: expectedRequest.media.path,
    title: expectedRequest.media.title,
    startPositionMs: expectedRequest.options.startPositionMs,
  });
  assert.match(capturedRequest.body.requestId, /^[0-9a-f-]{36}$/i);
  capturedRequest.body.requestId = expectedRequest.requestId;
  assert.deepEqual(capturedRequest.body, expectedRequest);
  assert.equal(capturedRequest.url, 'http://192.0.2.11:7777/v2/sessions');
  assert.equal(capturedRequest.options.headers.Authorization, `Bearer ${secret}`);
  assert.deepEqual(launched, { sessionId: statusFixture.sessionId, protocolVersion: 2 });

  const status = await getSessionStatus(selected, statusFixture.sessionId, 2);
  assert.deepEqual(status, {
    file: statusFixture.file,
    state: statusFixture.state,
    position: statusFixture.positionMs,
    duration: statusFixture.durationMs,
  });
});

test('documents the additive health and v2 info capability surface', () => {
  const health = fixture('health-v1-v2.json');
  const windows = fixture('info-v2.json');
  const linux = fixture('info-v2-linux.json');
  const requiredCapabilities = [
    'players.list',
    'sessions.create',
    'sessions.status',
    'sessions.control',
  ];
  assert.equal(health.protocolVersion, 1);
  assert.deepEqual(health.supportedProtocolVersions, [1, 2]);
  for (const capability of requiredCapabilities) {
    assert.equal(windows.capabilities.includes(capability), true);
    assert.equal(linux.capabilities.includes(capability), true);
  }
  assert.equal(windows.capabilities.includes('sessions.end-reasons'), true);
  assert.equal(linux.capabilities.includes('sessions.end-reasons'), true);
  assert.deepEqual(windows.acceptedPathKinds, ['windows-unc']);
  assert.deepEqual(linux.acceptedPathKinds, ['linux-absolute']);
  assert.equal(windows.maxConcurrentSessions, 1);
  assert.equal(linux.maxConcurrentSessions, 1);
  assert.deepEqual(fixture('session-control-v2.json'), {
    action: 'seek',
    positionMs: 42000,
  });
});
