const express = require('express');
const plexAuth = require('../plex-auth');

const router = express.Router();

router.post('/pin', async (_req, res) => {
  try {
    const pin = await plexAuth.requestPin();
    res.json({ ...pin, linkUrl: 'https://plex.tv/link' });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/pin/:id', async (req, res) => {
  try {
    const result = await plexAuth.checkPin(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/unlink', (_req, res) => {
  plexAuth.unlink();
  res.json({ linked: false });
});

module.exports = router;
