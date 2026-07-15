'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  activeProviderKind,
  configurationFor,
  createActiveProvider,
  publicProviderState,
} = require('../src/provider-manager');

const emptyEnvironment = Object.freeze({});

test('selects only supported environment overrides and otherwise uses saved settings', () => {
  assert.equal(
    activeProviderKind({ mediaProvider: 'plex' }, { MEDIA_PROVIDER: 'jellyfin' }),
    'jellyfin'
  );
  assert.equal(
    activeProviderKind({ mediaProvider: 'jellyfin' }, { MEDIA_PROVIDER: 'unsupported' }),
    'jellyfin'
  );
  assert.equal(activeProviderKind({}, emptyEnvironment), 'plex');
});

test('builds Plex configuration with environment precedence without exposing its token', () => {
  const configuration = configurationFor('plex', {
    settings: { plexUrl: 'http://saved:32400' },
    environment: { PLEX_URL: 'http://override:32400', PLEX_TOKEN: 'environment-secret' },
    readPlexToken: () => 'stored-secret',
  });

  assert.equal(configuration.baseUrl, 'http://override:32400');
  assert.equal(configuration.credentials.token, 'environment-secret');
  assert.equal(configuration.authenticated, true);
  const state = publicProviderState({
    kind: 'plex',
    settings: { plexUrl: 'http://saved:32400' },
    environment: { PLEX_URL: 'http://override:32400', PLEX_TOKEN: 'environment-secret' },
    readPlexToken: () => 'stored-secret',
  });
  assert.deepEqual(state, {
    provider: 'plex',
    label: 'Plex',
    configured: true,
    authenticated: true,
    ready: true,
    capabilities: {
      scanLibrary: true,
      search: true,
      watched: true,
      progress: true,
      related: true,
      directFile: true,
    },
  });
  assert.doesNotMatch(JSON.stringify(state), /secret/);
});

test('distinguishes environment-managed provider URLs from environment-managed credentials', () => {
  const urlOnly = configurationFor('plex', {
    settings: { plexUrl: 'http://saved:32400' },
    environment: { PLEX_URL: 'http://override:32400' },
    readPlexToken: () => 'stored-token',
  });

  assert.equal(urlOnly.urlEnvironmentManaged, true);
  assert.equal(urlOnly.credentialsEnvironmentManaged, false);
  assert.equal(urlOnly.environmentManaged, true);

  const credentialsOnly = configurationFor('plex', {
    settings: { plexUrl: 'http://saved:32400' },
    environment: { PLEX_TOKEN: 'environment-token' },
    readPlexToken: () => 'stored-token',
  });
  assert.equal(credentialsOnly.urlEnvironmentManaged, false);
  assert.equal(credentialsOnly.credentialsEnvironmentManaged, true);
  assert.equal(credentialsOnly.environmentManaged, true);
  assert.match(credentialsOnly.configurationError, /PLEX_TOKEN requires PLEX_URL/);
  assert.equal(credentialsOnly.authenticated, false);
});

test('requests a stored Plex token only for the normalized configured server', () => {
  let requestedScope;
  const configuration = configurationFor('plex', {
    settings: { plexUrl: 'http://plex.local:32400/' },
    environment: emptyEnvironment,
    readPlexToken: (serverUrl) => {
      requestedScope = serverUrl;
      return 'server-scoped-token';
    },
  });
  assert.equal(requestedScope, 'http://plex.local:32400');
  assert.equal(configuration.authenticated, true);
});

test('creates an immutable-provider factory input from one scoped Jellyfin snapshot', () => {
  let factoryOptions;
  const provider = createActiveProvider({
    settings: { mediaProvider: 'jellyfin', jellyfinUrl: 'http://jellyfin:8096/base' },
    environment: emptyEnvironment,
    readJellyfinCredentials: (serverUrl) => {
      assert.equal(serverUrl, 'http://jellyfin:8096/base');
      return {
        accessToken: 'private-token',
        userId: 'user-1',
        deviceId: 'device-1',
        isAdministrator: false,
      };
    },
    createJellyfin: (options) => {
      factoryOptions = options;
      return Object.freeze({ kind: 'jellyfin' });
    },
  });

  assert.equal(provider.kind, 'jellyfin');
  assert.deepEqual(factoryOptions, {
    baseUrl: 'http://jellyfin:8096/base',
    accessToken: 'private-token',
    userId: 'user-1',
    deviceId: 'device-1',
    isAdministrator: false,
    fetchImpl: undefined,
  });
});

test('reports Jellyfin scan capability only for an authenticated administrator', () => {
  const state = publicProviderState({
    kind: 'jellyfin',
    settings: { jellyfinUrl: 'http://jellyfin:8096' },
    environment: emptyEnvironment,
    readJellyfinCredentials: () => ({
      accessToken: 'token',
      userId: 'user',
      deviceId: 'device',
      isAdministrator: false,
    }),
  });
  assert.equal(state.ready, true);
  assert.equal(state.capabilities.scanLibrary, false);
});

test('fails closed before a provider factory runs when URL or credentials are missing', () => {
  assert.throws(
    () => createActiveProvider({
      settings: { mediaProvider: 'plex', plexUrl: '' },
      environment: emptyEnvironment,
      readPlexToken: () => 'token',
      createPlex: () => assert.fail('factory must not run'),
    }),
    (error) => error.status === 400 && error.code === 'provider_not_configured'
  );
  assert.throws(
    () => createActiveProvider({
      settings: { mediaProvider: 'plex', plexUrl: 'http://plex:32400' },
      environment: emptyEnvironment,
      readPlexToken: () => '',
      createPlex: () => assert.fail('factory must not run'),
    }),
    (error) => error.status === 401 && error.code === 'provider_not_authenticated'
  );
});

test('keeps invalid legacy URLs recoverable in Settings while provider creation fails closed', () => {
  const configuration = configurationFor('plex', {
    settings: { plexUrl: 'plex-server-without-a-scheme:32400' },
    environment: emptyEnvironment,
    readPlexToken: () => 'stored-token',
  });
  assert.equal(configuration.baseUrl, '');
  assert.equal(configuration.configured, false);
  assert.match(configuration.configurationError, /http:\/\/ or https:\/\//);

  const state = publicProviderState({
    kind: 'plex',
    settings: { plexUrl: 'plex-server-without-a-scheme:32400' },
    environment: emptyEnvironment,
    readPlexToken: () => 'stored-token',
  });
  assert.equal(state.ready, false);

  assert.throws(
    () => createActiveProvider({
      settings: { mediaProvider: 'plex', plexUrl: 'plex-server-without-a-scheme:32400' },
      environment: emptyEnvironment,
      readPlexToken: () => 'stored-token',
      createPlex: () => assert.fail('factory must not run'),
    }),
    (error) => error.status === 400 && error.code === 'provider_invalid_configuration'
  );
});
