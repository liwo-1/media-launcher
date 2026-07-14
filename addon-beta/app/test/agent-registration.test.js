const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dataDir = path.join(os.tmpdir(), `media-launcher-agent-registration-test-${process.pid}`);
process.env.DATA_DIR = dataDir;

const { readSettings, writeSettings } = require('../src/settings-store');
const { readAgentStore, writeAgentStore } = require('../src/agent-store');
const { PRODUCT, PROTOCOL_VERSION, registerPlayerAgent } = require('../src/agent-registration');

const firstId = '1'.repeat(32);
const secondId = '2'.repeat(32);

function register(overrides = {}) {
  return registerPlayerAgent({
    body: {
      product: PRODUCT,
      protocolVersion: PROTOCOL_VERSION,
      instanceId: firstId,
      port: 7777,
      ...overrides.body,
    },
    remoteAddress: overrides.remoteAddress || '::ffff:192.168.1.45',
    authorization: overrides.authorization || '',
  });
}

test.beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
});

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('first registration creates a private per-agent secret using the connection source address', () => {
  const result = register();

  assert.equal(result.status, 200);
  assert.match(result.body.secret, /^[a-f0-9]{48}$/);
  assert.equal(result.body.playerAgentUrl, 'http://192.168.1.45:7777');
  const store = readAgentStore();
  assert.equal(store.agents.length, 1);
  assert.equal(store.agents[0].instanceId, firstId);
  assert.equal(store.agents[0].url, 'http://192.168.1.45:7777');
  assert.equal(store.agents[0].secret, result.body.secret);
  assert.equal(store.agents[0].players[0].id, 'mpc-hc');
  assert.equal(readSettings().playerAgentSecret, '');
});

test('an agent-supplied enrollment key makes first registration retry idempotent', () => {
  const enrollmentSecret = 'd'.repeat(48);
  const first = register({ authorization: `Bearer ${enrollmentSecret}` });
  const retry = register({ authorization: `Bearer ${enrollmentSecret}` });

  assert.equal(first.status, 200);
  assert.equal(first.body.secret, enrollmentSecret);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.secret, enrollmentSecret);
  assert.equal(readAgentStore().agents.length, 1);
});

test('the same installation may refresh its network address only with its bearer secret', () => {
  const first = register();
  const sameAddressWithoutSecret = register();
  const sameAddressWithWrongSecret = register({ authorization: `Bearer ${'f'.repeat(48)}` });
  const rejected = register({ remoteAddress: '192.168.1.46' });
  const refreshed = register({
    remoteAddress: '192.168.1.46',
    authorization: `Bearer ${first.body.secret}`,
  });

  assert.equal(sameAddressWithoutSecret.status, 409);
  assert.equal(sameAddressWithWrongSecret.status, 409);
  assert.equal(rejected.status, 409);
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.secret, first.body.secret);
  assert.equal(readAgentStore().agents[0].url, 'http://192.168.1.46:7777');
});

test('different installations register independently with isolated secrets', () => {
  const first = register();
  const second = register({
    body: { instanceId: secondId },
    remoteAddress: '192.168.1.46',
  });

  assert.equal(second.status, 200);
  assert.notEqual(second.body.secret, first.body.secret);
  assert.deepEqual(
    readAgentStore().agents.map((agent) => agent.instanceId),
    [firstId, secondId]
  );
});

test('a new device coexists with a legacy pairing and only the old secret claims that record', () => {
  const secret = 'a'.repeat(48);
  writeSettings({ playerAgentUrl: 'http://old:7777', playerAgentSecret: secret });

  const independent = register();
  assert.equal(independent.status, 200);
  assert.equal(readAgentStore().agents.length, 2);

  const verified = register({
    body: { instanceId: secondId },
    remoteAddress: '192.168.1.46',
    authorization: `Bearer ${secret}`,
  });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.secret, secret);
  const store = readAgentStore();
  assert.equal(store.agents.length, 2);
  assert.deepEqual(store.agents.map((agent) => agent.instanceId), [secondId, firstId]);
  assert.equal(store.agents.some((agent) => agent.legacy), false);
});

test('negotiates v2 and stores a normalized player inventory additively over protocol v1', () => {
  const result = register({
    body: {
      supportedProtocolVersions: [1, 2],
      displayName: 'Living Room',
      platform: 'windows',
      architecture: 'x64',
      agentVersion: '1.4.0-beta.1',
      players: [{
        id: 'vlc',
        name: 'VLC',
        kind: 'vlc',
        capabilities: ['play.file', 'status.state', 'INVALID VALUE'],
      }],
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.selectedProtocolVersion, 2);
  const agent = readAgentStore().agents[0];
  assert.equal(agent.name, 'Living Room');
  assert.equal(agent.negotiatedProtocolVersion, 2);
  assert.deepEqual(agent.players[0].capabilities, ['play.file', 'status.state']);
});

test('an authenticated v2-to-v1 downgrade removes targets that v1 cannot dispatch', () => {
  const first = register({
    body: {
      supportedProtocolVersions: [1, 2],
      players: [{ id: 'vlc', name: 'VLC', kind: 'vlc', capabilities: ['play.file'] }],
    },
  });
  const downgraded = register({ authorization: `Bearer ${first.body.secret}` });

  assert.equal(downgraded.status, 200);
  const agent = readAgentStore().agents[0];
  assert.equal(agent.negotiatedProtocolVersion, 1);
  assert.deepEqual(agent.players.map((player) => player.id), ['mpc-hc']);
});

test('rejects unknown clients and invalid registration values', () => {
  assert.equal(register({ body: { product: 'something-else' } }).status, 400);
  assert.equal(register({ body: { protocolVersion: 2 } }).status, 400);
  assert.equal(register({ body: { instanceId: 'short' } }).status, 400);
  assert.equal(register({ body: { port: 0 } }).status, 400);
  assert.equal(register({ remoteAddress: ' ' }).status, 400);
});

test('rejects a revoked identity and caps persistent silent enrollments', () => {
  writeAgentStore({ agents: [], revokedInstanceIds: [firstId] });
  assert.equal(register().status, 403);

  writeAgentStore({
    agents: Array.from({ length: 16 }, (_, index) => ({
      instanceId: (index + 16).toString(16).padStart(32, '0'),
      name: `Player ${index}`,
      url: `http://192.168.2.${index + 1}:7777`,
      secret: index.toString(16).padStart(48, '0'),
      players: [],
    })),
  });
  assert.equal(register().status, 429);
});
