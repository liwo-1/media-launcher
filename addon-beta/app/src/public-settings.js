'use strict';

const { readSettings } = require('./settings-store');
const { publicAgent, readAgentStore } = require('./agent-store');
const { activeProviderKind, configurationFor, publicProviderState } = require('./provider-manager');

function mediaAccountSettings(settings) {
  const plexConfiguration = configurationFor('plex', { settings });
  const jellyfinConfiguration = configurationFor('jellyfin', { settings });
  return {
    plex: {
      linked: plexConfiguration.authenticated,
      accountDisplayName: '',
      serverName: '',
      isAdministrator: false,
      urlEnvironmentManaged: plexConfiguration.urlEnvironmentManaged,
      credentialsEnvironmentManaged: plexConfiguration.credentialsEnvironmentManaged,
      environmentManaged: plexConfiguration.environmentManaged,
      serverUrl: plexConfiguration.baseUrl,
    },
    jellyfin: {
      linked: jellyfinConfiguration.authenticated,
      accountDisplayName: jellyfinConfiguration.credentials.username || '',
      serverName: jellyfinConfiguration.credentials.serverName || '',
      isAdministrator: jellyfinConfiguration.credentials.isAdministrator === true,
      urlEnvironmentManaged: jellyfinConfiguration.urlEnvironmentManaged,
      credentialsEnvironmentManaged: jellyfinConfiguration.credentialsEnvironmentManaged,
      environmentManaged: jellyfinConfiguration.environmentManaged,
      serverUrl: jellyfinConfiguration.baseUrl,
    },
  };
}

function mediaServerSettings(settings, accounts = mediaAccountSettings(settings)) {
  const provider = activeProviderKind(settings);
  const state = publicProviderState({ settings, kind: provider });
  const account = accounts[provider];
  return {
    ...state,
    linked: account.linked,
    accountDisplayName: account.accountDisplayName || '',
    serverName: account.serverName || '',
    isAdministrator: account.isAdministrator === true,
    urlEnvironmentManaged: account.urlEnvironmentManaged === true,
    credentialsEnvironmentManaged: account.credentialsEnvironmentManaged === true,
    environmentManaged: account.environmentManaged === true,
    serverUrl: account.serverUrl,
  };
}

function publicSettings(settings = readSettings()) {
  const agentStore = readAgentStore();
  const mediaAccounts = mediaAccountSettings(settings);
  const providerOverride = typeof process.env.MEDIA_PROVIDER === 'string'
    ? process.env.MEDIA_PROVIDER.trim().toLowerCase()
    : '';
  return {
    // Explicit browser contract: persisted fields that are not named here stay private by
    // default, including unknown values left behind by older or future builds.
    mediaProvider: settings.mediaProvider === 'jellyfin' ? 'jellyfin' : 'plex',
    plexUrl: typeof settings.plexUrl === 'string' ? settings.plexUrl : '',
    jellyfinUrl: typeof settings.jellyfinUrl === 'string' ? settings.jellyfinUrl : '',
    playerAgentUrl: typeof settings.playerAgentUrl === 'string' ? settings.playerAgentUrl : '',
    pathMap: Array.isArray(settings.pathMap) ? settings.pathMap : [],
    defaultPlaybackTargetId: typeof settings.defaultPlaybackTargetId === 'string'
      ? settings.defaultPlaybackTargetId
      : '',
    alwaysAskPlaybackTarget: settings.alwaysAskPlaybackTarget !== false,
    mediaServer: mediaServerSettings(settings, mediaAccounts),
    mediaAccounts,
    mediaProviderEnvironmentManaged: providerOverride === 'plex' || providerOverride === 'jellyfin',
    agents: agentStore.agents.map(publicAgent),
    adminPinConfigured: Boolean(settings.adminPinHash),
    playerAgentKeyConfigured: Boolean(
      settings.playerAgentSecret || agentStore.agents.some((agent) => agent.secret)
    ),
    // Compatibility for one beta cycle while cached Settings pages migrate to mediaServer.
    plexLinked: mediaAccounts.plex.linked,
  };
}

module.exports = { mediaAccountSettings, mediaServerSettings, publicSettings };
