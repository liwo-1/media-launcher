const crypto = require('crypto');
const { readSettings, writeSettings } = require('./settings-store');

const PRODUCT = 'media-launcher-player-agent';
const PROTOCOL_VERSION = 1;

function generateSecret() {
  return crypto.randomBytes(24).toString('hex');
}

function bearerToken(authorization = '') {
  const match = /^Bearer\s+([a-f0-9]{48})$/i.exec(authorization);
  return match ? match[1].toLowerCase() : '';
}

function secretsMatch(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function normalizeRemoteAddress(address) {
  if (typeof address !== 'string' || !address.trim()) return '';
  const value = address.trim();
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}

function agentUrl(address, port) {
  const host = address.includes(':') ? `[${address}]` : address;
  return `http://${host}:${port}`;
}

function registerPlayerAgent({ body, remoteAddress, authorization = '' }) {
  const { product, protocolVersion, instanceId, port } = body || {};
  if (product !== PRODUCT || protocolVersion !== PROTOCOL_VERSION) {
    return { status: 400, body: { error: 'Unsupported player agent protocol' } };
  }
  if (typeof instanceId !== 'string' || !/^[a-f0-9]{32}$/i.test(instanceId)) {
    return { status: 400, body: { error: 'Invalid player agent instance ID' } };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { status: 400, body: { error: 'Invalid player agent port' } };
  }

  const address = normalizeRemoteAddress(remoteAddress);
  if (!address) return { status: 400, body: { error: 'Could not determine the player agent address' } };

  const normalizedId = instanceId.toLowerCase();
  const settings = readSettings();
  if (settings.playerAgentInstanceId && settings.playerAgentInstanceId !== normalizedId) {
    return {
      status: 409,
      body: { error: 'This add-on is already paired with a different player agent' },
    };
  }

  // Upgrades from the original add-on-initiated pairing have a secret but no instance ID.
  // Requiring that existing secret prevents an unrelated LAN client from claiming the pairing.
  if (!settings.playerAgentInstanceId && settings.playerAgentSecret) {
    const suppliedSecret = bearerToken(authorization);
    if (!secretsMatch(settings.playerAgentSecret, suppliedSecret)) {
      return {
        status: 409,
        body: { error: 'The existing player agent pairing could not be verified' },
      };
    }
  }

  const secret = settings.playerAgentSecret || generateSecret();
  const url = agentUrl(address, port);
  writeSettings({
    playerAgentUrl: url,
    playerAgentSecret: secret,
    playerAgentInstanceId: normalizedId,
  });

  return {
    status: 200,
    body: {
      paired: true,
      secret,
      playerAgentUrl: url,
      protocolVersion: PROTOCOL_VERSION,
    },
  };
}

module.exports = { PRODUCT, PROTOCOL_VERSION, registerPlayerAgent };
