const crypto = require('crypto');
const plex = require('./plex');
const { getSessionStatus } = require('./agent-client');

const POLL_INTERVAL_MS = 10000;
const WATCHED_THRESHOLD = 0.9;
const AUTO_ADVANCE_THRESHOLD = 0.9;
const MAX_POLL_DURATION_MS = 6 * 60 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 3;

const currentSessions = new Map();

function targetKey(target) {
  return target?.id || 'legacy';
}

function sessionIsCurrent(session) {
  return !session.cancelled && currentSessions.get(session.targetKey) === session;
}

function endSession(session) {
  session.cancelled = true;
  if (session.interval) clearInterval(session.interval);
  if (currentSessions.get(session.targetKey) === session) currentSessions.delete(session.targetKey);
}

async function getPlayerStatus(target, launch) {
  return getSessionStatus(target, launch.sessionId, launch.protocolVersion);
}

async function findNextEpisode(item) {
  if (item.type !== 'episode') return null;
  const episodes = await plex.getEpisodes(item.parentRatingKey);
  const sorted = [...episodes].sort((a, b) => a.index - b.index);
  const currentIdx = sorted.findIndex((episode) => String(episode.ratingKey) === String(item.ratingKey));
  if (currentIdx === -1 || currentIdx === sorted.length - 1) return null;
  return sorted[currentIdx + 1];
}

function createSession(
  item,
  target = null,
  launch = { sessionId: '', protocolVersion: 1 },
  expectedPath = ''
) {
  return {
    id: crypto.randomUUID(),
    item,
    target,
    targetKey: targetKey(target),
    launch,
    expectedPath,
    interval: null,
    startedAt: Date.now(),
    markedWatched: false,
    lastState: null,
    lastFraction: 0,
    consecutiveFailures: 0,
    cancelled: false,
    polling: false,
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
    reportTimeline: (...args) => plex.reportTimeline(...args),
    markWatched: (...args) => plex.markWatched(...args),
    findNextEpisode,
    playItem: (ratingKey, requestedTargetId) => require('./play').playItem(ratingKey, requestedTargetId),
    now: () => Date.now(),
  };
}

async function pollOnce(session, dependencies = defaultDependencies()) {
  if (!sessionIsCurrent(session) || session.polling) return;
  if (dependencies.now() - session.startedAt > MAX_POLL_DURATION_MS) {
    endSession(session);
    return;
  }

  session.polling = true;
  try {
    let status;
    try {
      status = await dependencies.getPlayerStatus(session.target, session.launch);
    } catch (err) {
      if (!sessionIsCurrent(session)) return;
      session.consecutiveFailures += 1;
      if (session.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) endSession(session);
      return;
    }
    if (!sessionIsCurrent(session)) return;
    session.consecutiveFailures = 0;
    if (!statusMatchesExpectedPath(status.file, session.expectedPath, session.target?.agent?.platform)) {
      endSession(session);
      return;
    }

    const state = status.state === 'playing' || status.state === 2
      ? 'playing'
      : status.state === 'paused' || status.state === 1
        ? 'paused'
        : 'stopped';
    const previousState = session.lastState;
    const previousFraction = session.lastFraction;
    const hasDuration = Number(status.duration) > 0;
    const fraction = hasDuration
      ? Math.max(0, Math.min(1, status.position / status.duration))
      : previousFraction;

    if (hasDuration) {
      try {
        await dependencies.reportTimeline(session.item.ratingKey, state, status.position, status.duration);
      } catch {
        // Progress reporting is best-effort.
      }
      if (!sessionIsCurrent(session)) return;
    }

    if (hasDuration && !session.markedWatched && fraction >= WATCHED_THRESHOLD) {
      session.markedWatched = true;
      try {
        await dependencies.markWatched(session.item.ratingKey);
      } catch {
        // Watched marking is best-effort and will not interrupt monitoring.
      }
      if (!sessionIsCurrent(session)) return;
    }

    session.lastState = state;
    session.lastFraction = fraction;

    const finishedNearEnd =
      previousState !== null &&
      previousState !== 'stopped' &&
      state === 'stopped' &&
      Math.max(previousFraction, fraction) >= AUTO_ADVANCE_THRESHOLD;

    if (finishedNearEnd) {
      const nextEpisode = await dependencies.findNextEpisode(session.item).catch(() => null);
      if (!sessionIsCurrent(session)) return;
      endSession(session);
      if (nextEpisode) {
        await dependencies.playItem(nextEpisode.ratingKey, session.target?.id || '').catch(() => {});
      }
      return;
    }

    if (state === 'stopped' && previousState !== null && fraction < AUTO_ADVANCE_THRESHOLD) {
      endSession(session);
    }
  } finally {
    session.polling = false;
  }
}

function monitorPlayback(item, target, launch, expectedPath = '') {
  const key = targetKey(target);
  const existing = currentSessions.get(key);
  if (existing) endSession(existing);
  const session = createSession(item, target, launch, expectedPath);
  currentSessions.set(key, session);
  session.interval = setInterval(() => {
    pollOnce(session).catch((err) => console.error(`playback monitor failed: ${err.message}`));
  }, POLL_INTERVAL_MS);
  return session;
}

module.exports = {
  monitorPlayback,
  _test: {
    createSession,
    pollOnce,
    endSession,
    statusMatchesExpectedPath,
    setCurrentSession(session) {
      const existing = currentSessions.get(session.targetKey);
      if (existing) endSession(existing);
      currentSessions.set(session.targetKey, session);
    },
    getCurrentSession: (key = 'legacy') => currentSessions.get(key) || null,
    getCurrentSessions: () => new Map(currentSessions),
    constants: { WATCHED_THRESHOLD, AUTO_ADVANCE_THRESHOLD, MAX_CONSECUTIVE_FAILURES },
  },
};
