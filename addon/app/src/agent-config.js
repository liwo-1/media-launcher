const crypto = require('crypto');
const { readSettings, writeSettings } = require('./settings-store');

const REQUEST_TIMEOUT_MS = 5000;

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

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseBody(response) {
  return response.json().catch(() => ({}));
}

async function pairPlayerAgent() {
  const playerAgentUrl = getPlayerAgentUrl();
  if (!playerAgentUrl) {
    return { paired: false, state: 'unconfigured', message: 'Save the player agent URL first.' };
  }

  let secret = getPlayerAgentSecret();
  let healthState = null;

  try {
    const healthResponse = await fetchWithTimeout(`${playerAgentUrl}/health`);
    if (!healthResponse.ok) throw new Error(`health check returned ${healthResponse.status}`);
    const health = await readResponseBody(healthResponse);
    if (typeof health.paired === 'boolean') healthState = health.paired;
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'request timed out' : err.message;
    throw new Error(`Could not reach the player agent: ${reason}`);
  }

  if (healthState === true && !secret) {
    throw new Error('The player agent is already paired. Reset pairing in its Windows Settings, then reload this page.');
  }

  // Existing installations should never renegotiate a working key. Any response other than an
  // auth/unpaired rejection proves the request passed the agent's bearer middleware; /status may
  // legitimately return 502 when MPC-HC's Web Interface is not running. Older agents do not
  // expose health.paired, so this check also preserves their existing manual pairing on upgrade.
  if (secret && healthState !== false) {
    try {
      const statusResponse = await fetchWithTimeout(`${playerAgentUrl}/status`, {
        headers: getPlayerAgentHeaders(),
      });
      if (statusResponse.status !== 401 && statusResponse.status !== 503) {
        return { paired: true, state: 'paired', alreadyPaired: true };
      }
      if (healthState === true) {
        throw new Error('The player agent is paired to a different key. Reset pairing in its Windows Settings, then reload this page.');
      }
    } catch (err) {
      if (err.message.includes('Reset pairing')) throw err;
      const reason = err.name === 'AbortError' ? 'request timed out' : err.message;
      throw new Error(`Could not verify the player-agent pairing: ${reason}`);
    }
  }

  if (!secret) {
    // Persist before sending so a lost HTTP response cannot leave the agent paired with a key the
    // add-on has forgotten. Retrying reuses this same key; the agent never accepts a replacement.
    secret = generatePlayerAgentSecret();
  }

  let response;
  try {
    response = await fetchWithTimeout(`${playerAgentUrl}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret }),
    });
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'request timed out' : err.message;
    throw new Error(`Could not reach the player agent: ${reason}`);
  }

  const body = await readResponseBody(response);
  if (response.ok) return { paired: true, state: 'paired', alreadyPaired: false };
  if (response.status === 409) {
    throw new Error('The player agent is paired to a different key. Reset pairing in its Windows Settings, then reload this page.');
  }
  if (response.status === 404) {
    throw new Error('This player agent does not support automatic pairing. Update the Windows agent first.');
  }
  throw new Error(body.error || `Player-agent pairing failed (${response.status})`);
}

module.exports = {
  getPlayerAgentUrl,
  getPlayerAgentSecret,
  getPlayerAgentHeaders,
  generatePlayerAgentSecret,
  pairPlayerAgent,
};
