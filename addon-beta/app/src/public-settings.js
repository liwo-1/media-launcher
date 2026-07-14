const { readSettings } = require('./settings-store');
const { publicAgent, readAgentStore } = require('./agent-store');
const plex = require('./plex');

function publicSettings(settings = readSettings()) {
  const { adminPinHash, playerAgentSecret, playerAgentInstanceId, ...publicValues } = settings;
  const agentStore = readAgentStore();
  return {
    ...publicValues,
    agents: agentStore.agents.map(publicAgent),
    adminPinConfigured: Boolean(adminPinHash),
    playerAgentKeyConfigured: Boolean(playerAgentSecret || agentStore.agents.some((agent) => agent.secret)),
    plexLinked: plex.hasToken(),
  };
}

module.exports = { publicSettings };
