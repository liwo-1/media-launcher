const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dataDir = path.join(os.tmpdir(), `media-launcher-jellyfin-login-test-${process.pid}`);
process.env.DATA_DIR = dataDir;
delete process.env.JELLYFIN_ACCESS_TOKEN;
delete process.env.JELLYFIN_URL;
delete process.env.JELLYFIN_USER_ID;

const auth = require('../src/jellyfin-auth');
const authStore = require('../src/jellyfin-auth-store');
const packageInfo = require('../package.json');

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test.beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
});

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('builds the modern MediaBrowser authorization header', () => {
  assert.equal(
    auth.buildAuthorizationHeader({ deviceId: 'device id', accessToken: 'token-value' }),
    'MediaBrowser Client="Media%20Launcher", Device="Home%20Assistant", ' +
      `DeviceId="device%20id", Version="${packageInfo.version}", Token="token-value"`
  );
});

test('authenticates with username/password once and persists only the returned token', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/Users/AuthenticateByName')) {
      return jsonResponse(200, {
        AccessToken: 'access-token',
        ServerId: 'server-id',
        User: {
          Id: 'user-id',
          Name: 'Movie User',
          Policy: { IsAdministrator: true },
        },
      });
    }
    return jsonResponse(200, {
      Id: 'server-id',
      ServerName: 'Family Media',
      ProductName: 'Jellyfin Server',
      Version: '10.11.11',
      StartupWizardCompleted: true,
    });
  };

  const result = await auth.authenticate({
    serverUrl: 'http://jellyfin.test:8096/base/',
    username: 'Movie User',
    password: 'private-password',
  }, fetchImpl);

  assert.equal(result.linked, true);
  assert.equal(requests[0].url, 'http://jellyfin.test:8096/base/System/Info/Public');
  assert.equal(requests[1].url, 'http://jellyfin.test:8096/base/Users/AuthenticateByName');
  assert.match(requests[1].options.headers.Authorization, /^MediaBrowser Client=/);
  assert.doesNotMatch(requests[1].options.headers.Authorization, /Token=/);
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    Username: 'Movie User',
    Pw: 'private-password',
  });
  const persisted = fs.readFileSync(authStore._test.STORE_PATH, 'utf8');
  assert.match(persisted, /access-token/);
  assert.doesNotMatch(persisted, /private-password/);
});

test('maps a rejected login to a safe authentication error', async () => {
  let calls = 0;
  await assert.rejects(
    auth.authenticate({
      serverUrl: 'http://jellyfin.test:8096',
      username: 'Movie User',
      password: 'wrong',
    }, async () => {
      calls++;
      return calls === 1
        ? jsonResponse(200, {
          ProductName: 'Jellyfin Server',
          Version: '10.11.11',
          StartupWizardCompleted: true,
        })
        : jsonResponse(401, { error: 'upstream detail' });
    }),
    (err) => err.status === 401 && /rejected the username or password/.test(err.message)
  );
});

test('refuses an unsupported server before sending a password', async () => {
  let calls = 0;
  await assert.rejects(
    auth.authenticate({
      serverUrl: 'http://jellyfin.test:8096',
      username: 'Movie User',
      password: 'private-password',
    }, async () => {
      calls++;
      return jsonResponse(200, {
        ProductName: 'Jellyfin Server',
        Version: '10.9.11',
        StartupWizardCompleted: true,
      });
    }),
    (err) => err.status === 426 && /10\.10\.7 or newer/.test(err.message)
  );
  assert.equal(calls, 1);
});

test('verifies a saved user token without putting it in the URL', async () => {
  authStore.saveCredentials({
    serverUrl: 'http://jellyfin.test:8096',
    accessToken: 'access-token',
    userId: 'user-id',
    username: 'Movie User',
  });
  let request;
  const result = await auth.verifyCredentials('http://jellyfin.test:8096', async (url, options) => {
    request = { url, options };
    return jsonResponse(200, { Id: 'user-id' });
  });

  assert.equal(result.reachable, true);
  assert.equal(request.url, 'http://jellyfin.test:8096/Users/Me');
  assert.match(request.options.headers.Authorization, /Token="access-token"/);
  assert.doesNotMatch(request.url, /access-token/);
});
