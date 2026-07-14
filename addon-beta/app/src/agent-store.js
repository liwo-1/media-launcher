const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./data-dir');
const { writeJsonAtomic } = require('./atomic-json');
const { readSettings } = require('./settings-store');

const STORE_PATH = path.join(DATA_DIR, 'agents.json');
const BACKUP_PATH = `${STORE_PATH}.bak`;
const SCHEMA_VERSION = 1;
const DEFAULT_PLAYER = Object.freeze({
  id: 'mpc-hc',
  name: 'MPC-HC',
  kind: 'mpc-hc',
  available: true,
  capabilities: ['play.file', 'fullscreen', 'status.state', 'status.position', 'status.duration'],
});

function stableHash(...parts) {
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24);
}

function agentRef(instanceId) {
  return `agent-${stableHash(instanceId)}`;
}

function targetId(instanceId, playerId) {
  return `target-${stableHash(instanceId, playerId)}`;
}

function normalizePathMap(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((rule) => typeof rule?.from === 'string' && typeof rule?.to === 'string')
    .map((rule) => ({
      from: rule.from,
      to: rule.to,
      ...(typeof rule.library === 'string' && rule.library ? { library: rule.library } : {}),
    }));
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string' && /^[a-z0-9.-]{1,64}$/.test(item)))];
}

function normalizePlayers(value, useLegacyFallback = false) {
  const players = Array.isArray(value)
    ? value
      .filter((player) => typeof player?.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(player.id))
      .map((player) => ({
        id: player.id.toLowerCase(),
        name: String(player.name || player.displayName || player.id).slice(0, 80),
        kind: String(player.kind || player.id).slice(0, 64),
        available: player.available !== false,
        capabilities: normalizeCapabilities(player.capabilities),
      }))
    : [];
  const unique = [...new Map(players.map((player) => [player.id, player])).values()];
  return unique.length || !useLegacyFallback ? unique : [{ ...DEFAULT_PLAYER }];
}

function emptyStore() {
  return { schemaVersion: SCHEMA_VERSION, agents: [], revokedInstanceIds: [] };
}

function legacyAgentFromSettings(settings = readSettings()) {
  const playerAgentUrl = process.env.PLAYER_AGENT_URL || settings.playerAgentUrl;
  const playerAgentSecret = process.env.PLAYER_AGENT_SECRET || settings.playerAgentSecret;
  if (!playerAgentUrl || !playerAgentSecret) return null;
  const hasInstanceId = /^[a-f0-9]{32}$/i.test(settings.playerAgentInstanceId || '');
  const instanceId = hasInstanceId
    ? settings.playerAgentInstanceId.toLowerCase()
    : `legacy-${stableHash(playerAgentUrl)}`;
  let pathMap = settings.pathMap;
  if (process.env.PATH_MAP) {
    try {
      pathMap = JSON.parse(process.env.PATH_MAP);
    } catch (err) {
      console.error(`Could not parse PATH_MAP: ${err.message}`);
      pathMap = [];
    }
  }
  return {
    instanceId,
    legacy: !hasInstanceId,
    paired: process.env.PLAYER_AGENT_SECRET
      ? true
      : settings.playerAgentPairingConfirmed !== false,
    name: 'Media PC',
    advertisedName: 'Media PC',
    nameCustomized: false,
    url: playerAgentUrl,
    secret: playerAgentSecret,
    platform: 'windows',
    architecture: 'x64',
    version: '',
    negotiatedProtocolVersion: 1,
    players: [{ ...DEFAULT_PLAYER }],
    pathMap: normalizePathMap(pathMap),
  };
}

function normalizeAgent(agent) {
  return {
    instanceId: String(agent.instanceId || ''),
    legacy: Boolean(agent.legacy),
    paired: agent.paired !== false && Boolean(agent.secret),
    name: String(agent.name || 'Media PC').slice(0, 80),
    advertisedName: String(agent.advertisedName || agent.name || 'Media PC').slice(0, 80),
    nameCustomized: Boolean(agent.nameCustomized),
    url: String(agent.url || ''),
    secret: String(agent.secret || ''),
    platform: String(agent.platform || 'windows').toLowerCase().slice(0, 32),
    architecture: String(agent.architecture || '').toLowerCase().slice(0, 32),
    version: String(agent.version || '').slice(0, 40),
    negotiatedProtocolVersion: Number(agent.negotiatedProtocolVersion) === 2 ? 2 : 1,
    players: normalizePlayers(agent.players, Boolean(agent.legacy || !agent.players)),
    pathMap: normalizePathMap(agent.pathMap),
  };
}

function normalizeStore(parsed) {
  if (!Array.isArray(parsed.agents)) throw new Error('agents must be an array');
  const store = {
    schemaVersion: SCHEMA_VERSION,
    agents: parsed.agents
      .map(normalizeAgent)
      .filter((agent) => agent.instanceId && agent.url && agent.secret),
    revokedInstanceIds: Array.isArray(parsed.revokedInstanceIds)
      ? [...new Set(parsed.revokedInstanceIds
        .filter((id) => typeof id === 'string' && /^[a-f0-9]{32}$/i.test(id))
        .map((id) => id.toLowerCase()))]
      : [],
  };
  store.agents = store.agents.filter(
    (agent) => !store.revokedInstanceIds.includes(agent.instanceId)
  );
  const legacy = legacyAgentFromSettings();
  if (legacy && !store.revokedInstanceIds.includes(legacy.instanceId)) {
    const exact = store.agents.findIndex(
      (agent) => agent.instanceId === legacy.instanceId || agent.secret === legacy.secret
    );
    if (
      exact >= 0 &&
      store.agents[exact].negotiatedProtocolVersion === 1 &&
      (process.env.PLAYER_AGENT_URL || process.env.PLAYER_AGENT_SECRET || process.env.PATH_MAP)
    ) {
      store.agents[exact] = {
        ...store.agents[exact],
        ...(process.env.PLAYER_AGENT_URL ? { url: legacy.url } : {}),
        ...(process.env.PLAYER_AGENT_SECRET
          ? { secret: legacy.secret, paired: legacy.paired }
          : {}),
        ...(process.env.PATH_MAP ? { pathMap: legacy.pathMap } : {}),
      };
    }
    if (exact < 0) {
      const oldLegacy = store.agents.findIndex((agent) => agent.legacy);
      if (oldLegacy >= 0) store.agents[oldLegacy] = legacy;
      else store.agents.push(legacy);
    }
  }
  return store;
}

function readStoreFile(filePath) {
  return normalizeStore(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function readAgentStore() {
  try {
    return readStoreFile(STORE_PATH);
  } catch (err) {
    const primaryExistsButFailed = err.code !== 'ENOENT';
    if (primaryExistsButFailed) console.error(`Could not read agent registry: ${err.message}`);
    try {
      const recovered = readStoreFile(BACKUP_PATH);
      writeJsonAtomic(STORE_PATH, recovered);
      console.error('Recovered the agent registry from its last-known-good backup.');
      return recovered;
    } catch (backupErr) {
      if (primaryExistsButFailed) {
        const quarantinePath = `${STORE_PATH}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(STORE_PATH, quarantinePath);
          console.error(`Preserved the unreadable agent registry as ${quarantinePath}.`);
        } catch (moveErr) {
          console.error(`Could not preserve the unreadable agent registry: ${moveErr.message}`);
        }
      }
    }
    const store = emptyStore();
    const legacy = legacyAgentFromSettings();
    if (legacy) store.agents.push(legacy);
    writeAgentStore(store);
    return store;
  }
}

function writeAgentStore(store) {
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    agents: (store.agents || []).map(normalizeAgent),
    revokedInstanceIds: Array.isArray(store.revokedInstanceIds)
      ? [...new Set(store.revokedInstanceIds
        .filter((id) => typeof id === 'string' && /^[a-f0-9]{32}$/i.test(id))
        .map((id) => id.toLowerCase()))]
      : [],
  };
  writeJsonAtomic(STORE_PATH, normalized);
  try {
    // The recovery copy must contain the committed post-mutation state. In particular, copying
    // the pre-write file here would let corruption resurrect a device that was just revoked.
    writeJsonAtomic(BACKUP_PATH, normalized);
  } catch (err) {
    console.error(`Could not update the agent-registry backup: ${err.message}`);
    try { fs.unlinkSync(BACKUP_PATH); } catch (unlinkErr) {
      if (unlinkErr.code !== 'ENOENT') {
        console.error(`Could not remove the stale agent-registry backup: ${unlinkErr.message}`);
      }
    }
  }
  return normalized;
}

function updateAgentStore(mutator) {
  const current = readAgentStore();
  const next = mutator({ ...current, agents: current.agents.map((agent) => ({ ...agent })) }) || current;
  if (JSON.stringify(next) !== JSON.stringify(current)) return writeAgentStore(next);
  return current;
}

function publicPlayer(agent, player) {
  return {
    id: targetId(agent.instanceId, player.id),
    playerId: player.id,
    name: player.name,
    kind: player.kind,
    available: player.available,
    capabilities: [...player.capabilities],
  };
}

function publicAgent(agent) {
  return {
    id: agentRef(agent.instanceId),
    name: agent.name,
    platform: agent.platform,
    architecture: agent.architecture,
    version: agent.version,
    paired: agent.paired,
    players: agent.players.map((player) => publicPlayer(agent, player)),
    pathMap: agent.pathMap.map((rule) => ({ ...rule })),
  };
}

function findAgentByRef(store, ref) {
  return store.agents.find((agent) => agentRef(agent.instanceId) === ref) || null;
}

function findTargetById(id, store = readAgentStore()) {
  for (const agent of store.agents) {
    if (!agent.paired || !agent.secret) continue;
    for (const player of agent.players) {
      if (
        player.available &&
        player.capabilities.includes('play.file') &&
        targetId(agent.instanceId, player.id) === id
      ) {
        return { id, agent, player };
      }
    }
  }
  return null;
}

function listTargets(store = readAgentStore()) {
  return store.agents.filter((agent) => agent.paired && agent.secret).flatMap((agent) =>
    agent.players
      .filter((player) => player.available && player.capabilities.includes('play.file'))
      .map((player) => ({
        id: targetId(agent.instanceId, player.id),
        instanceId: agent.instanceId,
        agentId: agentRef(agent.instanceId),
        agentName: agent.name,
        playerId: player.id,
        playerName: player.name,
        platform: agent.platform,
        architecture: agent.architecture,
        capabilities: [...player.capabilities],
      }))
  );
}

function syncLegacyAgent() {
  const legacy = legacyAgentFromSettings();
  if (!legacy) return readAgentStore();
  return updateAgentStore((store) => {
    if ((store.revokedInstanceIds || []).includes(legacy.instanceId)) return store;
    const exact = store.agents.findIndex(
      (agent) => agent.instanceId === legacy.instanceId || agent.secret === legacy.secret
    );
    if (exact >= 0) {
      store.agents[exact] = {
        ...store.agents[exact],
        url: legacy.url,
        secret: legacy.secret || store.agents[exact].secret,
        paired: store.agents[exact].paired || legacy.paired,
        pathMap: store.agents[exact].legacy && !store.agents[exact].pathMap.length
          ? legacy.pathMap
          : store.agents[exact].pathMap,
      };
      return store;
    }
    const oldLegacy = store.agents.findIndex((agent) => agent.legacy && agent.url === legacy.url);
    if (oldLegacy >= 0) {
      store.agents[oldLegacy] = {
        ...store.agents[oldLegacy],
        instanceId: legacy.instanceId,
        legacy: legacy.legacy,
        url: legacy.url,
        secret: legacy.secret || store.agents[oldLegacy].secret,
        paired: store.agents[oldLegacy].paired || legacy.paired,
        pathMap: store.agents[oldLegacy].pathMap.length
          ? store.agents[oldLegacy].pathMap
          : legacy.pathMap,
        name: store.agents[oldLegacy].name,
        nameCustomized: store.agents[oldLegacy].nameCustomized,
      };
    }
    else store.agents.push(legacy);
    return store;
  });
}

function removeAgentByRef(ref) {
  let removed = null;
  const store = updateAgentStore((current) => {
    const index = current.agents.findIndex((agent) => agentRef(agent.instanceId) === ref);
    if (index < 0) return current;
    [removed] = current.agents.splice(index, 1);
    if (/^[a-f0-9]{32}$/i.test(removed.instanceId)) {
      current.revokedInstanceIds = [...(current.revokedInstanceIds || []), removed.instanceId];
    }
    return current;
  });
  return { store, removed };
}

module.exports = {
  DEFAULT_PLAYER,
  agentRef,
  targetId,
  normalizePathMap,
  normalizePlayers,
  readAgentStore,
  writeAgentStore,
  updateAgentStore,
  publicAgent,
  findAgentByRef,
  findTargetById,
  listTargets,
  syncLegacyAgent,
  removeAgentByRef,
};
