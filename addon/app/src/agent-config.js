const crypto = require('crypto');
const { readSettings, writeSettings } = require('./settings-store');

function getPlayerAgentUrl() {
  return process.env.PLAYER_AGENT_URL || readSettings().playerAgentUrl || null;
}

function getPlayerAgentSecret() {
  return process.env.PLAYER_AGENT_SECRET || readSettings().playerAgentSecret || '';
}

function getPlayerAgentHeaders(extra = {}) {
  const secret = getPlayerAgentSecret();
  return {
    ...extra,
    ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
  };
}

function generatePlayerAgentSecret() {
  const playerAgentSecret = crypto.randomBytes(24).toString('hex');
  writeSettings({ playerAgentSecret });
  return playerAgentSecret;
}

module.exports = {
  getPlayerAgentUrl,
  getPlayerAgentSecret,
  getPlayerAgentHeaders,
  generatePlayerAgentSecret,
};
