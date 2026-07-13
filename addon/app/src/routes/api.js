const express = require('express');
const plex = require('../plex');
const { playItem, PlayError } = require('../play');

const router = express.Router();

router.get('/libraries', async (_req, res) => {
  try {
    const sections = await plex.getSections();
    res.json({ Items: sections });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/items', async (req, res) => {
  const { parentId } = req.query;
  if (!parentId) {
    return res.status(400).json({ error: 'parentId query param is required' });
  }
  try {
    const items = await plex.getItems(parentId);
    res.json({ Items: items });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/libraries/:key/recentlyAdded', async (req, res) => {
  try {
    const items = await plex.getRecentlyAdded(req.params.key);
    res.json({ Items: items });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/items/:id', async (req, res) => {
  try {
    const item = await plex.getItemFull(req.params.id);
    res.json(item);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/items/:id/related', async (req, res) => {
  try {
    const items = await plex.getRelated(req.params.id);
    res.json({ Items: items });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/shows/:id/seasons', async (req, res) => {
  try {
    const seasons = await plex.getSeasons(req.params.id);
    res.json({ Items: seasons });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/shows/:id/seasons/:seasonId/episodes', async (req, res) => {
  try {
    const episodes = await plex.getEpisodes(req.params.seasonId);
    res.json({ Items: episodes });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/libraries/:key/scan', async (req, res) => {
  try {
    await plex.scanLibrary(req.params.key);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/ondeck', async (_req, res) => {
  try {
    const items = await plex.getOnDeck();
    res.json({ Items: items });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/items/:id/watched', async (req, res) => {
  try {
    await plex.markWatched(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/items/:id/unwatched', async (req, res) => {
  try {
    await plex.markUnwatched(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/image', async (req, res) => {
  const relativePath = req.query.path;
  if (!relativePath || !relativePath.startsWith('/library/')) {
    return res.status(400).json({ error: 'query param "path" must be a Plex /library/... path' });
  }
  try {
    const imageResponse = await plex.getImage(relativePath);
    res.set('Content-Type', imageResponse.headers.get('content-type') || 'image/jpeg');
    const buffer = Buffer.from(await imageResponse.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/play/:id', async (req, res) => {
  try {
    const result = await playItem(req.params.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = err instanceof PlayError ? err.status : 502;
    console.error(`play failed for item ${req.params.id}: ${err.message}`);
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
