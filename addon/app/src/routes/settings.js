const express = require('express');
const { readSettings, writeSettings } = require('../settings-store');
const plex = require('../plex');

const router = express.Router();

router.get('/', (_req, res) => {
  res.json({ ...readSettings(), plexLinked: plex.hasToken() });
});

router.post('/', (req, res) => {
  const { plexUrl, playerAgentUrl, pathMap } = req.body || {};

  if (plexUrl !== undefined && typeof plexUrl !== 'string') {
    return res.status(400).json({ error: 'plexUrl must be a string' });
  }
  if (playerAgentUrl !== undefined && typeof playerAgentUrl !== 'string') {
    return res.status(400).json({ error: 'playerAgentUrl must be a string' });
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

  const settings = writeSettings(patch);
  res.json({ ...settings, plexLinked: plex.hasToken() });
});

module.exports = router;
