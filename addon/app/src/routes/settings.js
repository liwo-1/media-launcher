const express = require('express');
const { readSettings, writeSettings } = require('../settings-store');
const { hashPin } = require('../admin-auth');
const { pairPlayerAgent } = require('../agent-config');
const plex = require('../plex');

const router = express.Router();

function publicSettings(settings = readSettings()) {
  const { adminPinHash, playerAgentSecret, ...publicValues } = settings;
  return {
    ...publicValues,
    adminPinConfigured: Boolean(adminPinHash),
    playerAgentKeyConfigured: Boolean(playerAgentSecret),
    plexLinked: plex.hasToken(),
  };
}

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
  const { plexUrl, playerAgentUrl, pathMap, newAdminPin } = req.body || {};

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

  const patch = {};
  if (plexUrl !== undefined) patch.plexUrl = plexUrl.trim();
  if (playerAgentUrl !== undefined) patch.playerAgentUrl = playerAgentUrl.trim();
  if (pathMap !== undefined) patch.pathMap = pathMap;
  if (newAdminPin !== undefined) patch.adminPinHash = hashPin(newAdminPin);

  const existing = readSettings();
  if (!existing.adminPinHash && newAdminPin === undefined) {
    return res.status(400).json({ error: 'Set a 4 to 12 digit admin PIN before saving settings' });
  }

  const settings = writeSettings(patch);
  res.json(publicSettings(settings));
});

router.post('/player-agent/pair', async (_req, res) => {
  try {
    res.json(await pairPlayerAgent());
  } catch (err) {
    res.status(502).json({ error: err.message, paired: false, state: 'error' });
  }
});

module.exports = router;
