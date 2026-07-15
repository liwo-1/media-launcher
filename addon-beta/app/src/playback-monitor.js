'use strict';

const crypto = require('crypto');
const { getSessionStatus } = require('./agent-client');
const { agentRef } = require('./agent-store');

const POLL_INTERVAL_MS = 10000;
const WATCHED_THRESHOLD = 0.9;
const AUTO_ADVANCE_THRESHOLD = 0.9;
const MAX_POLL_DURATION_MS = 6 * 60 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 3;

const currentSessions = new Map();

function targetKey(target) {
  return target?.agent?.instanceId || target?.agentId || target?.id || 'legacy';
}

function sessionIsRegistered(session) {
  return !session.cancelled && currentSessions.get(session.targetKey) === session;
}

function sessionCanPoll(session) {
  return sessionIsRegistered(session) && !session.ending;
}

function endSession(session) {
  session.cancelled = true;
  session.ending = true;
  if (session.interval) clearInterval(session.interval);
  if (currentSessions.get(session.targetKey) === session) currentSessions.delete(session.targetKey);
}

function cancelProviderSessions(kind) {
  for (const session of currentSessions.values()) {
    if (session.provider.kind === kind) endSession(session);
  }
}

function findTargetSession(targetId, sessionId = '') {
  for (const session of currentSessions.values()) {
    if (session.target?.id !== targetId) continue;
    if (sessionId && session.launch?.sessionId !== sessionId) return null;
    return session;
  }
  return null;
}

function cancelTargetSession(targetId, sessionId = '') {
  const session = findTargetSession(targetId, sessionId);
  if (!session) return false;
  endSession(session);
  return true;
}

async function getPlayerStatus(target, launch) {
  return getSessionStatus(target, launch.sessionId, launch.protocolVersion);
}

function createSession(
  playback,
  provider,
  target = null,
  launch = { sessionId: '', protocolVersion: 1 },
  expectedPath = ''
) {
  if (!playback?.item?.id || !provider || playback.item.provider !== provider.kind) {
    throw new TypeError('A provider-qualified playback descriptor is required');
  }
  return {
    id: crypto.randomUUID(),
    playback,
    provider,
    target,
    targetKey: targetKey(target),
    launch,
    expectedPath,
    interval: null,
    startedAt: Date.now(),
    markedWatched: false,
    seenActive: false,
    lastState: null,
    lastFraction: 0,
    lastPositionMs: 0,
    lastDurationMs: 0,
    consecutiveFailures: 0,
    cancelled: false,
    ending: false,
    polling: false,
    providerQueue: Promise.resolve(),
    finalizationPromise: null,
  };
}

function statusMatchesExpectedPath(statusFile, expectedPath, platform = 'windows') {
  if (!statusFile || !expectedPath) return true;
  const normalize = (value) => {
    const normalized = String(value).trim().replace(/^"|"$/g, '').replace(/\\/g, '/');
    return platform === 'windows' ? normalized.toLowerCase() : normalized;
  };
  const actual = normalize(statusFile);
  const expected = normalize(expectedPath);
  const actualHasPath = actual.includes('/') || /^[a-z]:/i.test(actual);
  return actualHasPath
    ? actual === expected
    : actual === expected.slice(expected.lastIndexOf('/') + 1);
}

function defaultDependencies() {
  return {
    getPlayerStatus,
    reportProgress: (provider, playback, progress) => (
      provider.reportProgress(playback.item.id, { ...progress, context: playback.context })
    ),
    setWatched: (provider, playback) => provider.setWatched(playback.item.id, true),
    getNextPlayable: (provider, playback) => provider.getNextPlayable(playback),
    playResolved: (playback, provider, requestedTargetId) => (
      require('./play').launchResolvedPlayback(playback, provider, requestedTargetId)
    ),
    now: () => Date.now(),
  };
}

function queueProviderOperation(session, operation) {
  const pending = session.providerQueue.then(operation, operation);
  session.providerQueue = pending.catch(() => {});
  return pending;
}

async function tryBestEffort(operation, attempts = 1) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await operation();
      return true;
    } catch {
      // Provider updates are best-effort. Terminal updates get one immediate retry because there
      // will not be another polling tick after the session is removed.
    }
  }
  return false;
}

function statusMetrics(session, status, { forceStopped = false } = {}) {
  const state = forceStopped
    ? 'stopped'
    : status?.state === 'playing' || status?.state === 2
      ? 'playing'
      : status?.state === 'paused' || status?.state === 1
        ? 'paused'
        : 'stopped';
  const statusPosition = Number(status?.position);
  const statusDuration = Number(status?.duration);
  let positionMs = Number.isFinite(statusPosition) && statusPosition >= 0
    ? statusPosition
    : session.lastPositionMs;
  const hasDuration = Number.isFinite(statusDuration) && statusDuration > 0;
  if (state === 'stopped' && !hasDuration && positionMs === 0 && session.lastPositionMs > 0) {
    positionMs = session.lastPositionMs;
  }
  const durationMs = hasDuration ? statusDuration : session.lastDurationMs;
  const fraction = durationMs > 0
    ? Math.max(0, Math.min(1, positionMs / durationMs))
    : session.lastFraction;
  return { state, positionMs, durationMs, fraction, hasDuration };
}

async function recordStatus(session, status, dependencies, {
  final = false,
  forceStopped = false,
  assumeActive = false,
  allowEnding = false,
} = {}) {
  const metrics = statusMetrics(session, status, { forceStopped });
  const { state, positionMs, durationMs, fraction, hasDuration } = metrics;
  if (state === 'playing' || state === 'paused' || (assumeActive && durationMs > 0)) {
    session.seenActive = true;
  }

  const stillRelevant = () => allowEnding ? !session.cancelled : sessionCanPoll(session);
  if (session.seenActive && durationMs > 0 && (hasDuration || state === 'stopped')) {
    await queueProviderOperation(session, () => tryBestEffort(
      () => dependencies.reportProgress(session.provider, session.playback, {
        state,
        positionMs,
        durationMs,
      }),
      final ? 2 : 1
    ));
    if (!stillRelevant()) return { ...metrics, aborted: true };
  }

  if (
    session.seenActive &&
    durationMs > 0 &&
    !session.markedWatched &&
    fraction >= WATCHED_THRESHOLD
  ) {
    const marked = await queueProviderOperation(session, () => tryBestEffort(
      () => dependencies.setWatched(session.provider, session.playback),
      final ? 2 : 1
    ));
    // A failed attempt must remain retryable on the next poll. Previously the flag was set before
    // awaiting the provider and one transient failure permanently lost watched state.
    if (marked) session.markedWatched = true;
    if (!stillRelevant()) return { ...metrics, aborted: true };
  }

  session.lastState = state;
  session.lastFraction = fraction;
  session.lastPositionMs = positionMs;
  session.lastDurationMs = durationMs;
  return metrics;
}

async function finalizeSession(session, {
  dependencies = defaultDependencies(),
  endReason = 'stopped-by-request',
  status = null,
  refreshStatus = true,
} = {}) {
  if (!session || session.cancelled) return false;
  if (session.finalizationPromise) return session.finalizationPromise;

  session.ending = true;
  if (session.interval) clearInterval(session.interval);
  session.finalizationPromise = (async () => {
    let finalStatus = status;
    if (!finalStatus && refreshStatus) {
      try {
        finalStatus = await dependencies.getPlayerStatus(session.target, session.launch);
      } catch {
        // Fall back to the last successfully observed position below.
      }
    }
    if (
      finalStatus &&
      !statusMatchesExpectedPath(
        finalStatus.file,
        session.expectedPath,
        session.target?.agent?.platform
      )
    ) {
      finalStatus = null;
    }
    finalStatus = finalStatus || {
      state: 'stopped',
      position: session.lastPositionMs,
      duration: session.lastDurationMs,
    };
    await recordStatus(
      session,
      { ...finalStatus, state: 'stopped', endReason },
      dependencies,
      {
        final: true,
        forceStopped: true,
        // A session-specific terminal status with duration can be the first sample for a short
        // item stopped before the initial ten-second poll.
        assumeActive: Boolean(finalStatus && Number(finalStatus.duration) > 0),
        allowEnding: true,
      }
    );
    endSession(session);
    return true;
  })().catch((error) => {
    endSession(session);
    throw error;
  });
  return session.finalizationPromise;
}

async function finalizeTargetSession(targetId, sessionId = '', options = {}) {
  const session = findTargetSession(targetId, sessionId);
  return session ? finalizeSession(session, options) : false;
}

function publicAgentId(target) {
  if (target?.agent?.instanceId) return agentRef(target.agent.instanceId);
  return String(target?.agentId || target?.id || 'legacy');
}

function listPlaybackSessions() {
  return [...currentSessions.values()]
    .filter((session) => !session.cancelled)
    .map((session) => ({
      agentId: publicAgentId(session.target),
      targetId: String(session.target?.id || ''),
      sessionId: String(session.launch?.sessionId || ''),
      title: String(session.playback?.item?.title || ''),
      provider: String(session.provider?.kind || ''),
      agentName: String(session.target?.agent?.name || ''),
      playerName: String(session.target?.player?.name || ''),
      capabilities: Array.isArray(session.target?.player?.capabilities)
        ? session.target.player.capabilities.filter((value) => (
          typeof value === 'string' && value.startsWith('control.')
        ))
        : [],
      state: session.ending ? 'stopping' : session.lastState || 'starting',
      positionMs: session.lastPositionMs,
      durationMs: session.lastDurationMs,
    }));
}

async function pollOnce(session, dependencies = defaultDependencies()) {
  if (!sessionCanPoll(session) || session.polling) return;
  if (dependencies.now() - session.startedAt > MAX_POLL_DURATION_MS) {
    endSession(session);
    return;
  }

  session.polling = true;
  try {
    let status;
    try {
      status = await dependencies.getPlayerStatus(session.target, session.launch);
    } catch {
      if (!sessionCanPoll(session)) return;
      session.consecutiveFailures += 1;
      if (session.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) endSession(session);
      return;
    }
    if (!sessionCanPoll(session)) return;
    session.consecutiveFailures = 0;
    if (!statusMatchesExpectedPath(status.file, session.expectedPath, session.target?.agent?.platform)) {
      endSession(session);
      return;
    }

    const previousState = session.lastState;
    const previousFraction = session.lastFraction;
    const preliminary = statusMetrics(session, status);
    const explicitEnd = Boolean(status.endReason && status.endReason !== 'player-exited');
    const terminal = preliminary.state === 'stopped' && (
      explicitEnd || status.endReason === 'player-exited' || previousState !== null
    );
    const metrics = await recordStatus(session, status, dependencies, {
      final: terminal,
      assumeActive: Boolean(status.endReason),
    });
    if (metrics.aborted || !sessionCanPoll(session)) return;
    const { state, fraction } = metrics;

    // Explicit stop/replacement still gets the final provider timeline and watched update above,
    // but it must never trigger episode auto-advance.
    if (explicitEnd) {
      endSession(session);
      return;
    }

    const finishedNearEnd =
      state === 'stopped' &&
      (
        (previousState !== null && previousState !== 'stopped') ||
        status.endReason === 'player-exited'
      ) &&
      Math.max(previousFraction, fraction) >= AUTO_ADVANCE_THRESHOLD;

    if (finishedNearEnd) {
      const nextPlayback = await dependencies
        .getNextPlayable(session.provider, session.playback)
        .catch(() => null);
      if (!sessionCanPoll(session)) return;
      endSession(session);
      if (nextPlayback) {
        await dependencies
          .playResolved(nextPlayback, session.provider, session.target?.id || '')
          .catch(() => {});
      }
      return;
    }

    if (state === 'stopped' && previousState === 'stopped') {
      endSession(session);
      return;
    }

    if (state === 'stopped' && previousState !== null && fraction < AUTO_ADVANCE_THRESHOLD) {
      endSession(session);
    }
  } finally {
    session.polling = false;
  }
}

function monitorPlayback(
  playback,
  provider,
  target,
  launch,
  expectedPath = '',
  dependencies = defaultDependencies()
) {
  const key = targetKey(target);
  const existing = currentSessions.get(key);
  if (existing) {
    // Launching a different player on the same computer replaces the physical player's current
    // session. Preserve its final provider position before handing the monitor slot to the new
    // launch; finalization is session-scoped and cannot remove the replacement from the map.
    finalizeSession(existing, {
      dependencies,
      endReason: 'replaced',
      refreshStatus: true,
    }).catch((error) => console.error(`playback finalization failed: ${error.message}`));
  }
  const session = createSession(playback, provider, target, launch, expectedPath);
  currentSessions.set(key, session);
  session.interval = setInterval(() => {
    pollOnce(session, dependencies)
      .catch((error) => console.error(`playback monitor failed: ${error.message}`));
  }, POLL_INTERVAL_MS);
  session.interval.unref?.();
  return session;
}

module.exports = {
  cancelProviderSessions,
  cancelTargetSession,
  finalizeTargetSession,
  listPlaybackSessions,
  monitorPlayback,
  _test: {
    createSession,
    finalizeSession,
    pollOnce,
    recordStatus,
    endSession,
    statusMatchesExpectedPath,
    setCurrentSession(session) {
      const existing = currentSessions.get(session.targetKey);
      if (existing) endSession(existing);
      currentSessions.set(session.targetKey, session);
    },
    getCurrentSession(key = 'legacy') {
      const exact = currentSessions.get(key);
      if (exact) return exact;
      return [...currentSessions.values()].find((session) => session.target?.id === key) || null;
    },
    getCurrentSessions: () => new Map(currentSessions),
    constants: { WATCHED_THRESHOLD, AUTO_ADVANCE_THRESHOLD, MAX_CONSECUTIVE_FAILURES },
  },
};
