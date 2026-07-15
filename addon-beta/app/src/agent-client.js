const crypto = require('crypto');
const { readSettings } = require('./settings-store');
const { findTargetById, listTargets, readAgentStore } = require('./agent-store');

const REQUEST_TIMEOUT_MS = 5000;
const CONTROL_CAPABILITIES = Object.freeze({
  pause: 'control.pause',
  resume: 'control.pause',
  seek: 'control.seek',
  stop: 'control.stop',
});

class AgentRequestError extends Error {
  constructor(message, status = 502, transportFailure = false) {
    super(message);
    this.status = status;
    this.transportFailure = transportFailure;
  }
}

function agentHeaders(agent, extra = {}) {
  return {
    ...extra,
    ...(agent.secret ? { Authorization: `Bearer ${agent.secret}` } : {}),
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readBody(response) {
  return response.json().catch(() => ({}));
}

async function pairAgent(agent) {
  let response;
  try {
    response = await fetchWithTimeout(`${agent.url}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: agent.secret }),
    });
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'request timed out' : err.message;
    throw new AgentRequestError(`Could not reach ${agent.name}: ${reason}`);
  }
  const body = await readBody(response);
  if (!response.ok && response.status !== 409) {
    throw new AgentRequestError(body.error || `Pairing ${agent.name} failed (${response.status})`);
  }
}

async function send(agent, path, options) {
  try {
    return await fetchWithTimeout(`${agent.url}${path}`, options);
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'request timed out' : err.message;
    throw new AgentRequestError(`${agent.name} is not reachable: ${reason}`, 502, true);
  }
}

async function createSession(target, media) {
  const { agent, player } = target;
  const useV2 = agent.negotiatedProtocolVersion >= 2;
  const path = useV2 ? '/v2/sessions' : '/play';
  const body = useV2
    ? {
      requestId: crypto.randomUUID(),
      playerId: player.id,
      media: { sourceType: 'file', path: media.path, title: media.title || '' },
      options: { fullscreen: true, startPositionMs: media.startPositionMs || 0 },
    }
    : { path: media.path };
  const request = () => send(agent, path, {
    method: 'POST',
    headers: agentHeaders(agent, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });

  let response;
  try {
    response = await request();
  } catch (err) {
    if (!useV2 || !err.transportFailure) throw err;
    // v2 request IDs are idempotent. Retry once with the exact same body if the launch response
    // was lost; never retry v1 because it has no request-level deduplication.
    response = await request();
  }
  if (response.status === 503 && agent.legacy) {
    await pairAgent(agent);
    response = await request();
  }
  const responseBody = await readBody(response);
  if (!response.ok) {
    throw new AgentRequestError(responseBody.error || `${agent.name} returned ${response.status}`, response.status);
  }
  return {
    sessionId: typeof responseBody.sessionId === 'string' ? responseBody.sessionId : '',
    protocolVersion: useV2 ? 2 : 1,
  };
}

async function getSessionStatus(target, sessionId, protocolVersion) {
  const currentTarget = target?.id ? findTargetById(target.id) : target;
  if (!currentTarget) throw new AgentRequestError('The playback target was removed.', 404);
  const { agent } = currentTarget;
  const path = protocolVersion >= 2 && sessionId
    ? `/v2/sessions/${encodeURIComponent(sessionId)}`
    : '/status';
  const response = await send(agent, path, { headers: agentHeaders(agent) });
  const body = await readBody(response);
  if (!response.ok) throw new AgentRequestError(body.error || `${agent.name} status returned ${response.status}`);

  if (protocolVersion >= 2) {
    return {
      file: body.file || '',
      state: body.state || 'stopped',
      position: Number(body.positionMs) || 0,
      duration: Number(body.durationMs) || 0,
      ...(typeof body.endReason === 'string' && body.endReason
        ? { endReason: body.endReason }
        : {}),
    };
  }
  return {
    file: body.file || '',
    state: body.state === 2 ? 'playing' : body.state === 1 ? 'paused' : 'stopped',
    position: Number(body.position) || 0,
    duration: Number(body.duration) || 0,
  };
}

async function controlSession(targetId, sessionId, control) {
  // Resolve the opaque target ID again for every command. Browser input can therefore never
  // choose an agent URL or credential, and a removed/re-paired target cannot use stale secrets.
  const target = findTargetById(targetId);
  if (!target) throw new AgentRequestError('The selected playback target no longer exists.', 404);

  const { agent, player } = target;
  if (agent.negotiatedProtocolVersion < 2) {
    throw new AgentRequestError('Playback controls require agent protocol version 2.', 409);
  }

  const capability = CONTROL_CAPABILITIES[control.action];
  if (!capability || !player.capabilities.includes(capability)) {
    throw new AgentRequestError(`${player.name} does not support ${control.action}.`, 409);
  }

  const body = { action: control.action };
  if (control.action === 'seek') body.positionMs = control.positionMs;
  const response = await send(
    agent,
    `/v2/sessions/${encodeURIComponent(sessionId)}/control`,
    {
      method: 'POST',
      headers: agentHeaders(agent, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    }
  );
  const responseBody = await readBody(response);
  if (!response.ok) {
    throw new AgentRequestError(
      responseBody.error || `${agent.name} returned ${response.status}`,
      response.status
    );
  }
  return responseBody;
}

function resolvePlaybackTarget(requestedTargetId) {
  const store = readAgentStore();
  if (requestedTargetId) {
    const requested = findTargetById(requestedTargetId, store);
    if (!requested) throw new AgentRequestError('The selected playback target no longer exists.', 404);
    return requested;
  }

  const settings = readSettings();
  if (settings.defaultPlaybackTargetId) {
    const preferred = findTargetById(settings.defaultPlaybackTargetId, store);
    if (preferred) return preferred;
    throw new AgentRequestError(
      'The configured default playback target is unavailable. Choose a playback target explicitly.',
      409
    );
  }

  const targets = listTargets(store);
  if (targets.length === 1) return findTargetById(targets[0].id, store);
  if (targets.length === 0) throw new AgentRequestError('No playback targets are configured yet.', 400);
  throw new AgentRequestError('Choose a playback target before starting playback.', 409);
}

module.exports = {
  AgentRequestError,
  agentHeaders,
  fetchWithTimeout,
  createSession,
  controlSession,
  getSessionStatus,
  resolvePlaybackTarget,
};
