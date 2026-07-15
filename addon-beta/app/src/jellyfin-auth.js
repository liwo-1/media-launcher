const packageInfo = require('../package.json');
const {
  getCredentialSnapshot,
  getDeviceId,
  saveCredentials,
} = require('./jellyfin-auth-store');
const { joinServerPath, normalizeServerUrl } = require('./server-url');

const CLIENT_NAME = 'Media Launcher';
const DEVICE_NAME = 'Home Assistant';
const REQUEST_TIMEOUT_MS = 15000;
const MINIMUM_VERSION = Object.freeze([10, 10, 7]);

function headerValue(value) {
  return encodeURIComponent(String(value ?? ''));
}

function buildAuthorizationHeader({ deviceId, accessToken = '' }) {
  const parts = [
    `Client="${headerValue(CLIENT_NAME)}"`,
    `Device="${headerValue(DEVICE_NAME)}"`,
    `DeviceId="${headerValue(deviceId)}"`,
    `Version="${headerValue(packageInfo.version)}"`,
  ];
  if (accessToken) parts.push(`Token="${headerValue(accessToken)}"`);
  return `MediaBrowser ${parts.join(', ')}`;
}

function authenticationHeaders(deviceId = getDeviceId(), accessToken = '') {
  return {
    Accept: 'application/json',
    Authorization: buildAuthorizationHeader({ deviceId, accessToken }),
  };
}

async function parseJsonResponse(response, action) {
  if (response.status >= 300 && response.status < 400) {
    const err = new Error(
      `Jellyfin redirected the ${action} request. Save the exact server URL, including its base path.`
    );
    err.status = 400;
    throw err;
  }
  if (!response.ok) {
    const err = new Error(
      response.status === 401
        ? 'Jellyfin rejected the username or password.'
        : `Jellyfin ${action} failed (${response.status}).`
    );
    err.status = response.status === 401 ? 401 : 502;
    throw err;
  }
  try {
    return await response.json();
  } catch {
    const err = new Error(`Jellyfin returned an invalid ${action} response.`);
    err.status = 502;
    throw err;
  }
}

function assertSupportedServer(info) {
  if (!info || typeof info !== 'object' || !/jellyfin/i.test(String(info.ProductName || ''))) {
    const err = new Error('The configured address did not identify itself as a Jellyfin server.');
    err.status = 400;
    throw err;
  }
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(info.Version || ''));
  if (!match) {
    const err = new Error('Jellyfin did not report a supported server version.');
    err.status = 426;
    throw err;
  }
  const actual = match.slice(1).map(Number);
  let comparison = 0;
  for (let index = 0; index < MINIMUM_VERSION.length; index++) {
    if (actual[index] === MINIMUM_VERSION[index]) continue;
    comparison = actual[index] > MINIMUM_VERSION[index] ? 1 : -1;
    break;
  }
  if (comparison < 0) {
    const err = new Error('Jellyfin 10.10.7 or newer is required.');
    err.status = 426;
    throw err;
  }
  if (info.StartupWizardCompleted === false) {
    const err = new Error('Finish the Jellyfin setup wizard before connecting Media Launcher.');
    err.status = 409;
    throw err;
  }
  return info;
}

async function getPublicServerInfo(serverUrl, fetchImpl = global.fetch) {
  let response;
  try {
    response = await fetchImpl(joinServerPath(serverUrl, '/System/Info/Public'), {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    const err = new Error('Could not reach the Jellyfin server. Check its URL and network access.');
    err.status = 502;
    throw err;
  }
  return assertSupportedServer(await parseJsonResponse(response, 'server information'));
}

async function authenticateCandidate({ serverUrl, username, password }, fetchImpl = global.fetch) {
  const normalizedUrl = normalizeServerUrl(serverUrl || '', {
    required: true,
    field: 'Jellyfin server URL',
  });
  if (typeof username !== 'string' || !username.trim() || username.trim().length > 256) {
    const err = new Error('Jellyfin username is required and must be at most 256 characters.');
    err.status = 400;
    throw err;
  }
  if (typeof password !== 'string' || password.length > 4096) {
    const err = new Error('Jellyfin password must be a string of at most 4096 characters.');
    err.status = 400;
    throw err;
  }

  // Verify the unauthenticated server identity before sending a user password to the configured
  // address. This also catches a missing Jellyfin base path without exposing credentials to a
  // redirect target.
  const publicInfo = await getPublicServerInfo(normalizedUrl, fetchImpl);
  const deviceId = getDeviceId();
  let response;
  try {
    response = await fetchImpl(joinServerPath(normalizedUrl, '/Users/AuthenticateByName'), {
      method: 'POST',
      headers: {
        ...authenticationHeaders(deviceId),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ Username: username.trim(), Pw: password }),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.status) throw err;
    const wrapped = new Error('Could not reach the Jellyfin server. Check its URL and network access.');
    wrapped.status = 502;
    throw wrapped;
  }

  const result = await parseJsonResponse(response, 'authentication');
  const accessToken = typeof result.AccessToken === 'string' ? result.AccessToken : '';
  const userId = typeof result.User?.Id === 'string' ? result.User.Id : '';
  if (!accessToken || !userId) {
    const err = new Error('Jellyfin authenticated but did not return a user access token.');
    err.status = 502;
    throw err;
  }

  const credentials = {
    serverUrl: normalizedUrl,
    accessToken,
    userId,
    serverId: result.ServerId || publicInfo.Id || '',
    serverName: publicInfo.ServerName || '',
    username: result.User.Name || username.trim(),
    isAdministrator: result.User.Policy?.IsAdministrator === true,
  };
  return {
    credentials,
    publicResult: {
      linked: true,
      accountDisplayName: credentials.username,
      serverName: credentials.serverName,
      isAdministrator: credentials.isAdministrator,
    },
  };
}

async function authenticate(options, fetchImpl = global.fetch) {
  const candidate = await authenticateCandidate(options, fetchImpl);
  const stored = saveCredentials(candidate.credentials);
  return {
    linked: true,
    accountDisplayName: stored.username,
    serverName: stored.serverName,
    isAdministrator: stored.isAdministrator,
  };
}

async function verifyCredentials(serverUrl, fetchImpl = global.fetch) {
  const normalizedUrl = normalizeServerUrl(serverUrl || '', {
    required: true,
    field: 'Jellyfin server URL',
  });
  const credentials = getCredentialSnapshot(normalizedUrl);
  if (!credentials.accessToken || !credentials.userId) return { linked: false, reachable: false };
  try {
    const response = await fetchImpl(joinServerPath(normalizedUrl, '/Users/Me'), {
      headers: authenticationHeaders(credentials.deviceId, credentials.accessToken),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return {
      linked: true,
      reachable: response.ok,
      accountDisplayName: credentials.username,
    };
  } catch {
    return { linked: true, reachable: false, accountDisplayName: credentials.username };
  }
}

module.exports = {
  authenticate,
  authenticateCandidate,
  assertSupportedServer,
  authenticationHeaders,
  buildAuthorizationHeader,
  getPublicServerInfo,
  verifyCredentials,
  _test: { CLIENT_NAME, DEVICE_NAME, MINIMUM_VERSION, REQUEST_TIMEOUT_MS },
};
