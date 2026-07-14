const express = require('express');
const { readSettings, writeSettings } = require('../settings-store');
const { hashPin } = require('../admin-auth');
const { publicSettings } = require('../public-settings');
const {
  findAgentByRef,
  findTargetById,
  normalizePathMap,
  readAgentStore,
  removeAgentByRef,
  syncLegacyAgent,
  targetId,
  writeAgentStore,
} = require('../agent-store');
const plex = require('../plex');

const router = express.Router();

function isHttpUrl(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

router.get('/', (_req, res) => {
  res.json(publicSettings());
});

router.get('/plex-libraries', async (_req, res) => {
  try {
    const paths = await plex.getLibraryPaths();
    res.json({ paths });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

router.post('/', (req, res) => {
  const currentSettings = readSettings();
  const {
    plexUrl,
    playerAgentUrl,
    pathMap,
    agentSettings,
    defaultPlaybackTargetId,
    alwaysAskPlaybackTarget,
    newAdminPin,
  } = req.body || {};

  if (plexUrl !== undefined && typeof plexUrl !== 'string') {
    return res.status(400).json({ error: 'plexUrl must be a string' });
  }
  if (playerAgentUrl !== undefined && typeof playerAgentUrl !== 'string') {
    return res.status(400).json({ error: 'playerAgentUrl must be a string' });
  }
  if (plexUrl !== undefined && !isHttpUrl(plexUrl.trim())) {
    return res.status(400).json({ error: 'plexUrl must be an http:// or https:// URL' });
  }
  if (playerAgentUrl !== undefined && !isHttpUrl(playerAgentUrl.trim())) {
    return res.status(400).json({ error: 'playerAgentUrl must be an http:// or https:// URL' });
  }
  if (newAdminPin !== undefined && (typeof newAdminPin !== 'string' || !/^\d{4,12}$/.test(newAdminPin))) {
    return res.status(400).json({ error: 'Admin PIN must contain 4 to 12 digits' });
  }
  if (
    pathMap !== undefined &&
    (!Array.isArray(pathMap) || pathMap.some((r) => typeof r?.from !== 'string' || typeof r?.to !== 'string'))
  ) {
    return res.status(400).json({ error: 'pathMap must be an array of { from, to } strings' });
  }
  if (agentSettings !== undefined && !Array.isArray(agentSettings)) {
    return res.status(400).json({ error: 'agentSettings must be an array' });
  }
  if (
    defaultPlaybackTargetId !== undefined &&
    (typeof defaultPlaybackTargetId !== 'string' || defaultPlaybackTargetId.length > 80)
  ) {
    return res.status(400).json({ error: 'defaultPlaybackTargetId must be a string' });
  }
  if (alwaysAskPlaybackTarget !== undefined && typeof alwaysAskPlaybackTarget !== 'boolean') {
    return res.status(400).json({ error: 'alwaysAskPlaybackTarget must be a boolean' });
  }

  const agentStore = readAgentStore();
  const hasManagedAgents = agentStore.agents.length > 0;
  if (agentSettings !== undefined) {
    const seen = new Set();
    for (const agentPatch of agentSettings) {
      if (
        typeof agentPatch?.id !== 'string' ||
        typeof agentPatch?.name !== 'string' ||
        !agentPatch.name.trim() ||
        agentPatch.name.trim().length > 80 ||
        !Array.isArray(agentPatch.pathMap) ||
        agentPatch.pathMap.some((rule) => typeof rule?.from !== 'string' || typeof rule?.to !== 'string')
      ) {
        return res.status(400).json({ error: 'Each agent setting requires a valid id, name, and pathMap' });
      }
      if (seen.has(agentPatch.id)) return res.status(400).json({ error: 'Duplicate agent setting id' });
      seen.add(agentPatch.id);
      const agent = findAgentByRef(agentStore, agentPatch.id);
      if (!agent) return res.status(400).json({ error: 'A configured player agent no longer exists' });
      const nextName = agentPatch.name.trim();
      if (nextName !== agent.name) {
        agent.name = nextName;
        agent.nameCustomized = nextName !== agent.advertisedName;
      }
      agent.pathMap = normalizePathMap(agentPatch.pathMap);
    }
  } else if (pathMap !== undefined && agentStore.agents.length === 1) {
    // A cached pre-migration frontend still edits the legacy global map. Keep that one target in
    // sync so upgrading the backend cannot silently leave it using stale paths.
    agentStore.agents[0].pathMap = normalizePathMap(pathMap);
  }
  if (
    playerAgentUrl !== undefined &&
    playerAgentUrl.trim() &&
    agentSettings === undefined &&
    agentStore.agents.length === 1
  ) {
    // Compatibility for a cached singleton Settings page: update only its network endpoint and
    // retain the private key, player inventory, friendly name, and per-device mapping.
    agentStore.agents[0].url = playerAgentUrl.trim();
  }

  if (
    defaultPlaybackTargetId &&
    defaultPlaybackTargetId !== currentSettings.defaultPlaybackTargetId &&
    !findTargetById(defaultPlaybackTargetId, agentStore)
  ) {
    return res.status(400).json({ error: 'The selected default playback target no longer exists' });
  }

  const patch = {};
  if (plexUrl !== undefined) patch.plexUrl = plexUrl.trim();
  if (playerAgentUrl !== undefined) patch.playerAgentUrl = playerAgentUrl.trim();
  if (pathMap !== undefined) patch.pathMap = pathMap;
  if (defaultPlaybackTargetId !== undefined) patch.defaultPlaybackTargetId = defaultPlaybackTargetId;
  if (alwaysAskPlaybackTarget !== undefined) patch.alwaysAskPlaybackTarget = alwaysAskPlaybackTarget;
  if (newAdminPin !== undefined) patch.adminPinHash = hashPin(newAdminPin);

  if (
    agentSettings !== undefined ||
    (pathMap !== undefined && agentStore.agents.length === 1) ||
    (playerAgentUrl !== undefined && agentSettings === undefined && agentStore.agents.length === 1)
  ) {
    writeAgentStore(agentStore);
  }
  const settings = writeSettings(patch);
  if (!hasManagedAgents && playerAgentUrl !== undefined && playerAgentUrl.trim()) syncLegacyAgent();
  res.json(publicSettings(settings));
});

router.post('/admin-pin/disable', (_req, res) => {
  const settings = writeSettings({ adminPinHash: '' });
  res.json(publicSettings(settings));
});

router.delete('/agents/:id', (req, res) => {
  const store = readAgentStore();
  const agent = findAgentByRef(store, req.params.id);
  if (!agent) return res.status(404).json({ error: 'The player agent no longer exists' });
  if (
    (process.env.PLAYER_AGENT_URL && process.env.PLAYER_AGENT_URL === agent.url) ||
    (process.env.PLAYER_AGENT_SECRET && process.env.PLAYER_AGENT_SECRET === agent.secret)
  ) {
    return res.status(409).json({
      error: 'This player agent is configured by environment variables. Remove those overrides first.',
    });
  }

  const removedTargetIds = new Set(agent.players.map((player) => targetId(agent.instanceId, player.id)));
  removeAgentByRef(req.params.id);

  const settings = readSettings();
  const patch = {};
  if (removedTargetIds.has(settings.defaultPlaybackTargetId)) patch.defaultPlaybackTargetId = '';
  if (
    settings.playerAgentInstanceId === agent.instanceId ||
    (settings.playerAgentUrl === agent.url && settings.playerAgentSecret === agent.secret)
  ) {
    Object.assign(patch, {
      playerAgentUrl: '',
      playerAgentSecret: '',
      playerAgentInstanceId: '',
      playerAgentPairingConfirmed: null,
    });
  }
  const nextSettings = Object.keys(patch).length ? writeSettings(patch) : settings;
  return res.json(publicSettings(nextSettings));
});

module.exports = router;
