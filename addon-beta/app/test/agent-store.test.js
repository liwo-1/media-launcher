const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dataDir = path.join(os.tmpdir(), `media-launcher-agent-store-test-${process.pid}`);
process.env.DATA_DIR = dataDir;

const { writeSettings } = require('../src/settings-store');
const {
  agentRef,
  readAgentStore,
  removeAgentByRef,
  syncLegacyAgent,
  targetId,
  writeAgentStore,
} = require('../src/agent-store');
const { publicSettings } = require('../src/public-settings');

test.beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  delete process.env.PLAYER_AGENT_URL;
  delete process.env.PLAYER_AGENT_SECRET;
  delete process.env.PATH_MAP;
});

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('migrates singleton settings and path mappings into one private agent idempotently', () => {
  const instanceId = '1'.repeat(32);
  const secret = 'a'.repeat(48);
  writeSettings({
    playerAgentUrl: 'http://media-pc:7777',
    playerAgentSecret: secret,
    playerAgentInstanceId: instanceId,
    pathMap: [{ from: '/media', to: '//nas/media' }],
  });

  const first = readAgentStore();
  const second = readAgentStore();

  assert.deepEqual(second, first);
  assert.equal(first.agents.length, 1);
  assert.equal(first.agents[0].instanceId, instanceId);
  assert.equal(first.agents[0].secret, secret);
  assert.deepEqual(first.agents[0].pathMap, [{ from: '/media', to: '//nas/media' }]);
});

test('browser-facing settings recursively omit private installation IDs and secrets', () => {
  const instanceId = '2'.repeat(32);
  const secret = 'b'.repeat(48);
  writeSettings({
    playerAgentUrl: 'http://media-pc:7777',
    playerAgentSecret: secret,
    playerAgentInstanceId: instanceId,
  });
  readAgentStore();

  const values = publicSettings();
  const serialized = JSON.stringify(values);

  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(instanceId), false);
  assert.equal(values.agents.length, 1);
  assert.equal(values.agents[0].players[0].id, targetId(instanceId, 'mpc-hc'));
});

test('legacy compatibility sync cannot overwrite v2 capabilities or per-agent mappings', () => {
  const instanceId = '3'.repeat(32);
  writeAgentStore({
    agents: [{
      instanceId,
      name: 'Living Room',
      nameCustomized: true,
      url: 'http://old-address:7777',
      secret: 'c'.repeat(48),
      platform: 'windows',
      architecture: 'x64',
      version: '1.4.0-beta.1',
      negotiatedProtocolVersion: 2,
      players: [{ id: 'vlc', name: 'VLC', kind: 'vlc', capabilities: ['play.file'] }],
      pathMap: [{ from: '/media', to: '//living-room/media' }],
    }],
  });
  writeSettings({
    playerAgentUrl: 'http://new-address:7777',
    playerAgentSecret: 'c'.repeat(48),
    playerAgentInstanceId: instanceId,
    pathMap: [{ from: '/media', to: '//stale/global' }],
  });

  const synced = syncLegacyAgent().agents[0];

  assert.equal(synced.url, 'http://new-address:7777');
  assert.equal(synced.name, 'Living Room');
  assert.equal(synced.negotiatedProtocolVersion, 2);
  assert.equal(synced.players[0].id, 'vlc');
  assert.deepEqual(synced.pathMap, [{ from: '/media', to: '//living-room/media' }]);
});

test('supports a legacy environment-only agent and field-specific environment overrides', () => {
  process.env.PLAYER_AGENT_URL = 'http://env-player:7777';
  process.env.PLAYER_AGENT_SECRET = 'd'.repeat(48);
  process.env.PATH_MAP = JSON.stringify([{ from: '/media', to: '//env/media' }]);

  const first = readAgentStore().agents[0];
  assert.equal(first.url, 'http://env-player:7777');
  assert.equal(first.secret, 'd'.repeat(48));
  assert.deepEqual(first.pathMap, [{ from: '/media', to: '//env/media' }]);

  writeSettings({
    playerAgentUrl: 'http://saved-player:7777',
    playerAgentSecret: 'd'.repeat(48),
    playerAgentPairingConfirmed: true,
  });
  process.env.PLAYER_AGENT_URL = 'http://new-env-player:7777';
  delete process.env.PLAYER_AGENT_SECRET;
  delete process.env.PATH_MAP;
  const changedUrl = readAgentStore().agents[0];
  assert.equal(changedUrl.url, 'http://new-env-player:7777');
  assert.deepEqual(changedUrl.pathMap, [{ from: '/media', to: '//env/media' }]);
});

test('recovers a corrupt registry from its last committed backup', () => {
  const first = {
    instanceId: '4'.repeat(32),
    name: 'Known good',
    url: 'http://known-good:7777',
    secret: 'e'.repeat(48),
    players: [],
  };
  writeAgentStore({ agents: [first] });
  writeAgentStore({ agents: [{ ...first, name: 'Latest' }] });
  fs.writeFileSync(path.join(dataDir, 'agents.json'), '{truncated');

  const recovered = readAgentStore();
  assert.equal(recovered.agents[0].name, 'Latest');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(dataDir, 'agents.json'), 'utf8')));
});

test('removing a modern agent creates a tombstone and keeps it out of target lists', () => {
  const instanceId = '5'.repeat(32);
  writeAgentStore({
    agents: [{
      instanceId,
      name: 'Old player',
      url: 'http://old-player:7777',
      secret: 'f'.repeat(48),
      players: [{ id: 'mpc-hc', name: 'MPC-HC', capabilities: ['play.file'] }],
    }],
  });

  const result = removeAgentByRef(agentRef(instanceId));
  assert.equal(result.removed.instanceId, instanceId);
  const store = readAgentStore();
  assert.equal(store.agents.length, 0);
  assert.deepEqual(store.revokedInstanceIds, [instanceId]);
});

test('registry recovery cannot resurrect a revoked device', () => {
  const instanceId = '6'.repeat(32);
  writeAgentStore({
    agents: [{
      instanceId,
      name: 'Revoked player',
      url: 'http://revoked-player:7777',
      secret: 'a'.repeat(48),
      players: [],
    }],
  });
  removeAgentByRef(agentRef(instanceId));
  fs.writeFileSync(path.join(dataDir, 'agents.json'), '{truncated');

  const recovered = readAgentStore();
  assert.equal(recovered.agents.length, 0);
  assert.deepEqual(recovered.revokedInstanceIds, [instanceId]);
});

test('restores a missing primary registry from the committed backup', () => {
  const instanceId = '7'.repeat(32);
  writeAgentStore({
    agents: [{
      instanceId,
      name: 'Backed up player',
      url: 'http://backup-player:7777',
      secret: 'b'.repeat(48),
      players: [],
    }],
    revokedInstanceIds: ['8'.repeat(32)],
  });
  fs.unlinkSync(path.join(dataDir, 'agents.json'));

  const recovered = readAgentStore();
  assert.equal(recovered.agents[0].instanceId, instanceId);
  assert.deepEqual(recovered.revokedInstanceIds, ['8'.repeat(32)]);
  assert.equal(fs.existsSync(path.join(dataDir, 'agents.json')), true);
});
