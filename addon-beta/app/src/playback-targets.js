const { readSettings } = require('./settings-store');
const { agentRef, listTargets, readAgentStore } = require('./agent-store');
const { agentHeaders, fetchWithTimeout } = require('./agent-client');

async function isOnline(agent) {
  if (!agent.paired || !agent.secret) return false;
  try {
    const path = agent.negotiatedProtocolVersion >= 2 ? '/v2/info' : '/status';
    const response = await fetchWithTimeout(
      `${agent.url}${path}`,
      { headers: agentHeaders(agent) },
      1800
    );
    return agent.negotiatedProtocolVersion >= 2
      ? response.ok
      : response.status === 200 || response.status === 502;
  } catch {
    return false;
  }
}

async function getPlaybackTargets() {
  const store = readAgentStore();
  const states = await Promise.all(
    store.agents.map(async (agent) => [agent.instanceId, await isOnline(agent)])
  );
  const onlineByAgent = new Map(states);
  const agents = store.agents.map((agent) => ({
    id: agentRef(agent.instanceId),
    paired: agent.paired,
    online: onlineByAgent.get(agent.instanceId) || false,
  }));
  const targets = listTargets(store).map((target) => ({
    id: target.id,
    agentId: target.agentId,
    name: `${target.agentName} — ${target.playerName}`,
    agentName: target.agentName,
    playerName: target.playerName,
    platform: target.platform,
    architecture: target.architecture,
    capabilities: target.capabilities,
    online: onlineByAgent.get(target.instanceId) || false,
  }));
  const settings = readSettings();
  const configuredDefault = settings.defaultPlaybackTargetId || '';
  const defaultPlaybackTargetAvailable = targets.some(
    (target) => target.id === configuredDefault
  );
  targets.sort((left, right) => {
    if (left.id === configuredDefault) return -1;
    if (right.id === configuredDefault) return 1;
    return left.name.localeCompare(right.name);
  });
  return {
    agents,
    targets,
    defaultPlaybackTargetId: configuredDefault,
    defaultPlaybackTargetAvailable,
    alwaysAskPlaybackTarget: settings.alwaysAskPlaybackTarget !== false,
  };
}

module.exports = { getPlaybackTargets };
