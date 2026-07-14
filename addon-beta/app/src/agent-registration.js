const crypto = require('crypto');
const {
  normalizePlayers,
  readAgentStore,
  writeAgentStore,
} = require('./agent-store');
const { writeSettings } = require('./settings-store');

const PRODUCT = 'media-launcher-player-agent';
const PROTOCOL_VERSION = 1;
const CURRENT_PROTOCOL_VERSION = 2;
const MAX_AGENTS = 16;
const NEW_REGISTRATION_WINDOW_MS = 5 * 60 * 1000;
const MAX_NEW_REGISTRATIONS_PER_ADDRESS = 10;
const recentRegistrations = new Map();

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

function cleanText(value, fallback, maxLength) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : fallback;
}

function requestedProtocol(body) {
  const supported = Array.isArray(body?.supportedProtocolVersions)
    ? body.supportedProtocolVersions.filter(Number.isInteger)
    : [PROTOCOL_VERSION];
  return supported.includes(CURRENT_PROTOCOL_VERSION) ? CURRENT_PROTOCOL_VERSION : PROTOCOL_VERSION;
}

function allowNewRegistration(address) {
  const now = Date.now();
  const recent = (recentRegistrations.get(address) || [])
    .filter((timestamp) => now - timestamp < NEW_REGISTRATION_WINDOW_MS);
  if (recent.length >= MAX_NEW_REGISTRATIONS_PER_ADDRESS) {
    recentRegistrations.set(address, recent);
    return false;
  }
  recent.push(now);
  recentRegistrations.set(address, recent);
  return true;
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
  const suppliedSecret = bearerToken(authorization);
  const store = readAgentStore();
  if ((store.revokedInstanceIds || []).includes(normalizedId)) {
    return {
      status: 403,
      body: { error: 'This player-agent identity was removed. Reset pairing locally to enroll it again.' },
    };
  }
  const originalStore = JSON.stringify(store);
  let index = store.agents.findIndex((agent) => agent.instanceId === normalizedId);
  let existing = index >= 0 ? store.agents[index] : null;
  let claimedLegacy = false;

  // A pre-registry installation may have a URL/key but no installation ID. The first new-style
  // registration atomically claims that record only when it proves possession of the old key.
  if (!existing && suppliedSecret) {
    const legacyIndex = store.agents.findIndex(
      (agent) => agent.legacy && secretsMatch(agent.secret, suppliedSecret)
    );
    if (legacyIndex >= 0) {
      index = legacyIndex;
      existing = store.agents[legacyIndex];
      claimedLegacy = true;
    }
  }

  if (!existing && store.agents.length >= MAX_AGENTS) {
    return {
      status: 429,
      body: { error: `The player-agent limit (${MAX_AGENTS}) has been reached. Remove an old device first.` },
    };
  }
  if (!existing && !allowNewRegistration(address)) {
    return { status: 429, body: { error: 'Too many new player agents registered from this address.' } };
  }

  const url = agentUrl(address, port);
  if (existing?.secret && !secretsMatch(existing.secret, suppliedSecret)) {
    return { status: 409, body: { error: 'The existing player agent pairing could not be verified' } };
  }

  const negotiatedProtocolVersion = requestedProtocol(body);
  const secret = existing?.secret || suppliedSecret || generateSecret();
  let players;
  if (negotiatedProtocolVersion === PROTOCOL_VERSION) {
    // v1 has no player selection. Never retain stale v2 targets after an agent downgrade.
    players = normalizePlayers(undefined, true);
  } else {
    const advertisedPlayers = body.players === undefined
      ? existing?.players
      : normalizePlayers(body.players);
    players = advertisedPlayers || [];
  }
  const advertisedName = cleanText(body.displayName || body.name, existing?.advertisedName || 'Media PC', 80);
  const agent = {
    ...(existing || {}),
    instanceId: normalizedId,
    legacy: false,
    paired: true,
    name: existing?.nameCustomized ? existing.name : advertisedName,
    advertisedName,
    nameCustomized: Boolean(existing?.nameCustomized),
    url,
    secret,
    platform: cleanText(body.platform, existing?.platform || 'windows', 32).toLowerCase(),
    architecture: cleanText(body.architecture, existing?.architecture || '', 32).toLowerCase(),
    version: cleanText(body.agentVersion, existing?.version || '', 40),
    negotiatedProtocolVersion,
    players,
    pathMap: existing?.pathMap || [],
  };

  if (index >= 0) store.agents[index] = agent;
  else store.agents.push(agent);
  if (JSON.stringify(store) !== originalStore) writeAgentStore(store);
  if (claimedLegacy && !process.env.PLAYER_AGENT_URL && !process.env.PLAYER_AGENT_SECRET) {
    writeSettings({
      playerAgentUrl: url,
      playerAgentInstanceId: normalizedId,
      playerAgentPairingConfirmed: true,
    });
  }

  return {
    status: 200,
    body: {
      paired: true,
      secret,
      playerAgentUrl: url,
      protocolVersion: PROTOCOL_VERSION,
      selectedProtocolVersion: negotiatedProtocolVersion,
      registrationRefreshSeconds: 300,
    },
  };
}

module.exports = {
  PRODUCT,
  PROTOCOL_VERSION,
  CURRENT_PROTOCOL_VERSION,
  registerPlayerAgent,
};
