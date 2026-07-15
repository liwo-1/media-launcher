'use strict';

const { MediaProviderError } = require('./media-model');
const { readSettings } = require('./settings-store');
const { getStoredToken } = require('./token-store');
const { getCredentialSnapshot } = require('./jellyfin-auth-store');
const { normalizeServerUrl } = require('./server-url');

const PROVIDER_DEFINITIONS = Object.freeze({
  plex: Object.freeze({
    label: 'Plex',
    capabilities: Object.freeze({
      scanLibrary: true,
      search: true,
      watched: true,
      progress: true,
      related: true,
      directFile: true,
    }),
  }),
  jellyfin: Object.freeze({
    label: 'Jellyfin',
    capabilities: Object.freeze({
      scanLibrary: true,
      search: true,
      watched: true,
      progress: true,
      related: true,
      directFile: true,
    }),
  }),
});

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeConfiguredUrl(value, field) {
  try {
    return {
      baseUrl: normalizeServerUrl(value, { field }),
      configurationError: '',
    };
  } catch (error) {
    return {
      baseUrl: '',
      configurationError: error.message || `${field} is invalid`,
    };
  }
}

function activeProviderKind(settings = readSettings(), environment = process.env) {
  const override = cleanString(environment.MEDIA_PROVIDER).toLowerCase();
  if (Object.hasOwn(PROVIDER_DEFINITIONS, override)) return override;
  return settings?.mediaProvider === 'jellyfin' ? 'jellyfin' : 'plex';
}

function configurationFor(kind, {
  settings = readSettings(),
  environment = process.env,
  readPlexToken = getStoredToken,
  readJellyfinCredentials = getCredentialSnapshot,
} = {}) {
  if (!Object.hasOwn(PROVIDER_DEFINITIONS, kind)) {
    throw new MediaProviderError('Unsupported media provider.', {
      status: 400,
      code: 'unsupported_provider',
      provider: cleanString(kind),
    });
  }

  if (kind === 'plex') {
    const urlEnvironmentManaged = Boolean(cleanString(environment.PLEX_URL));
    const credentialsEnvironmentManaged = Boolean(cleanString(environment.PLEX_TOKEN));
    const normalized = normalizeConfiguredUrl(
      cleanString(environment.PLEX_URL) || cleanString(settings?.plexUrl),
      'Plex server URL'
    );
    const { baseUrl } = normalized;
    let configurationError = normalized.configurationError;
    const environmentToken = cleanString(environment.PLEX_TOKEN);
    if (environmentToken && !urlEnvironmentManaged) {
      configurationError = 'PLEX_TOKEN requires PLEX_URL so the credential is bound to one server.';
    }
    const token = environmentToken || cleanString(readPlexToken(baseUrl));
    return {
      kind,
      baseUrl,
      configured: Boolean(baseUrl),
      authenticated: Boolean(token) && !configurationError,
      credentials: { token },
      configurationError,
      urlEnvironmentManaged,
      credentialsEnvironmentManaged,
      environmentManaged: urlEnvironmentManaged || credentialsEnvironmentManaged,
    };
  }

  const urlEnvironmentManaged = Boolean(cleanString(environment.JELLYFIN_URL));
  const credentialsEnvironmentManaged = Boolean(cleanString(environment.JELLYFIN_ACCESS_TOKEN));
  const normalized = normalizeConfiguredUrl(
    cleanString(environment.JELLYFIN_URL) || cleanString(settings?.jellyfinUrl),
    'Jellyfin server URL'
  );
  const { baseUrl } = normalized;
  let configurationError = normalized.configurationError;
  let credentials = {};
  if (baseUrl) {
    try {
      credentials = readJellyfinCredentials(baseUrl) || {};
    } catch (error) {
      configurationError = error.message || 'Jellyfin credentials could not be loaded.';
    }
  }
  const accessToken = cleanString(credentials?.accessToken);
  const userId = cleanString(credentials?.userId);
  return {
    kind,
    baseUrl,
    configured: Boolean(baseUrl),
    authenticated: Boolean(accessToken && userId),
    credentials: {
      accessToken,
      userId,
      deviceId: cleanString(credentials?.deviceId),
      isAdministrator: credentials?.isAdministrator === true,
      username: cleanString(credentials?.username),
      serverName: cleanString(credentials?.serverName),
    },
    configurationError,
    urlEnvironmentManaged,
    credentialsEnvironmentManaged,
    environmentManaged: urlEnvironmentManaged || credentialsEnvironmentManaged,
  };
}

function publicProviderState(options = {}) {
  const settings = options.settings || readSettings();
  const kind = options.kind || activeProviderKind(settings, options.environment);
  const configuration = configurationFor(kind, { ...options, settings });
  const definition = PROVIDER_DEFINITIONS[kind];
  const capabilities = kind === 'jellyfin'
    ? Object.freeze({
      ...definition.capabilities,
      scanLibrary: configuration.credentials.isAdministrator === true,
    })
    : definition.capabilities;
  return {
    provider: kind,
    label: definition.label,
    configured: configuration.configured,
    authenticated: configuration.authenticated,
    ready: configuration.configured && configuration.authenticated,
    capabilities,
  };
}

function createProvider(kind, options = {}) {
  const configuration = configurationFor(kind, options);
  if (configuration.configurationError) {
    throw new MediaProviderError(configuration.configurationError, {
      status: 400,
      code: 'provider_invalid_configuration',
      provider: kind,
    });
  }
  if (!configuration.configured) {
    throw new MediaProviderError(`${PROVIDER_DEFINITIONS[kind].label} server URL is not configured.`, {
      status: 400,
      code: 'provider_not_configured',
      provider: kind,
    });
  }
  if (!configuration.authenticated) {
    throw new MediaProviderError(`${PROVIDER_DEFINITIONS[kind].label} account is not linked.`, {
      status: 401,
      code: 'provider_not_authenticated',
      provider: kind,
    });
  }

  if (kind === 'plex') {
    const factory = options.createPlex || require('./providers/plex-provider').createPlexProvider;
    return factory({
      baseUrl: configuration.baseUrl,
      token: configuration.credentials.token,
      fetchImpl: options.fetchImpl,
    });
  }

  const factory = options.createJellyfin || require('./providers/jellyfin-provider').createJellyfinProvider;
  const { accessToken, userId, deviceId, isAdministrator } = configuration.credentials;
  return factory({
    baseUrl: configuration.baseUrl,
    accessToken,
    userId,
    deviceId,
    isAdministrator,
    fetchImpl: options.fetchImpl,
  });
}

function createActiveProvider(options = {}) {
  const settings = options.settings || readSettings();
  return createProvider(activeProviderKind(settings, options.environment), { ...options, settings });
}

module.exports = {
  PROVIDER_DEFINITIONS,
  activeProviderKind,
  configurationFor,
  createActiveProvider,
  createProvider,
  publicProviderState,
};
