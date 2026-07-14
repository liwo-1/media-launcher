const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dataDir = path.join(os.tmpdir(), `media-launcher-agent-registration-test-${process.pid}`);
process.env.DATA_DIR = dataDir;

const { readSettings, writeSettings } = require('../src/settings-store');
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

test('first registration creates and binds a secret using the connection source address', () => {
  const result = register();

  assert.equal(result.status, 200);
  assert.match(result.body.secret, /^[a-f0-9]{48}$/);
  assert.equal(result.body.playerAgentUrl, 'http://192.168.1.45:7777');
  assert.deepEqual(readSettings(), {
    plexUrl: '',
    playerAgentUrl: 'http://192.168.1.45:7777',
    playerAgentSecret: result.body.secret,
    playerAgentInstanceId: firstId,
    adminPinHash: '',
    pathMap: [],
  });
});

test('the same installation gets the same secret and may refresh its network address', () => {
  const first = register();
  const second = register({ remoteAddress: '192.168.1.46' });

  assert.equal(second.status, 200);
  assert.equal(second.body.secret, first.body.secret);
  assert.equal(readSettings().playerAgentUrl, 'http://192.168.1.46:7777');
});

test('a different installation cannot replace an existing pairing', () => {
  const first = register();
  const second = register({ body: { instanceId: secondId } });

  assert.equal(second.status, 409);
  assert.equal(readSettings().playerAgentSecret, first.body.secret);
  assert.equal(readSettings().playerAgentInstanceId, firstId);
});

test('a legacy pairing requires its existing bearer secret before binding an installation', () => {
  const secret = 'a'.repeat(48);
  writeSettings({ playerAgentUrl: 'http://old:7777', playerAgentSecret: secret });

  assert.equal(register().status, 409);
  const verified = register({ authorization: `Bearer ${secret}` });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.secret, secret);
  assert.equal(readSettings().playerAgentInstanceId, firstId);
});

test('rejects unknown clients and invalid registration values', () => {
  assert.equal(register({ body: { product: 'something-else' } }).status, 400);
  assert.equal(register({ body: { protocolVersion: 2 } }).status, 400);
  assert.equal(register({ body: { instanceId: 'short' } }).status, 400);
  assert.equal(register({ body: { port: 0 } }).status, 400);
  assert.equal(register({ remoteAddress: ' ' }).status, 400);
});
