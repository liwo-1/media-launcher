const express = require('express');
const { pairPlayerAgent } = require('../agent-config');
const { registerPlayerAgent } = require('../agent-registration');

const router = express.Router();

router.post('/register', (req, res) => {
  const result = registerPlayerAgent({
    body: req.body,
    remoteAddress: req.socket.remoteAddress,
    authorization: req.get('Authorization') || '',
  });
  res.status(result.status).json(result.body);
});

router.post('/pair', async (_req, res) => {
  try {
    res.json(await pairPlayerAgent());
  } catch (err) {
    res.status(502).json({ error: err.message, paired: false, state: 'error' });
  }
});

module.exports = router;
