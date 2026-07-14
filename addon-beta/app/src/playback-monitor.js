const crypto = require('crypto');
const plex = require('./plex');
const { getPlayerAgentUrl, getPlayerAgentHeaders } = require('./agent-config');

const POLL_INTERVAL_MS = 10000;
const WATCHED_THRESHOLD = 0.9;
const AUTO_ADVANCE_THRESHOLD = 0.9;
const MAX_POLL_DURATION_MS = 6 * 60 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 3;

let currentSession = null;

function sessionIsCurrent(session) {
  return !session.cancelled && session === currentSession;
}

function endSession(session) {
  session.cancelled = true;
  if (session.interval) clearInterval(session.interval);
  if (session === currentSession) currentSession = null;
}

async function getPlayerStatus() {
  const playerAgentUrl = getPlayerAgentUrl();
  if (!playerAgentUrl) throw new Error('Player agent URL is not configured');
  const response = await fetch(`${playerAgentUrl}/status`, {
    headers: getPlayerAgentHeaders(),
  });
  if (!response.ok) throw new Error(`player-agent /status returned ${response.status}`);
  return response.json();
}

async function findNextEpisode(item) {
  if (item.type !== 'episode') return null;
  const episodes = await plex.getEpisodes(item.parentRatingKey);
  const sorted = [...episodes].sort((a, b) => a.index - b.index);
  const currentIdx = sorted.findIndex((episode) => String(episode.ratingKey) === String(item.ratingKey));
  if (currentIdx === -1 || currentIdx === sorted.length - 1) return null;
  return sorted[currentIdx + 1];
}

function createSession(item) {
  return {
    id: crypto.randomUUID(),
    item,
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

function defaultDependencies() {
  return {
    getPlayerStatus,
    reportTimeline: (...args) => plex.reportTimeline(...args),
    markWatched: (...args) => plex.markWatched(...args),
    findNextEpisode,
    playItem: (ratingKey) => require('./play').playItem(ratingKey),
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
      status = await dependencies.getPlayerStatus();
    } catch (err) {
      if (!sessionIsCurrent(session)) return;
      session.consecutiveFailures += 1;
      if (session.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) endSession(session);
      return;
    }
    if (!sessionIsCurrent(session)) return;
    session.consecutiveFailures = 0;

    const state = status.state === 2 ? 'playing' : status.state === 1 ? 'paused' : 'stopped';
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
      if (nextEpisode) await dependencies.playItem(nextEpisode.ratingKey).catch(() => {});
      return;
    }

    if (state === 'stopped' && previousState !== null && fraction < AUTO_ADVANCE_THRESHOLD) {
      endSession(session);
    }
  } finally {
    session.polling = false;
  }
}

function monitorPlayback(item) {
  if (currentSession) endSession(currentSession);
  const session = createSession(item);
  currentSession = session;
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
    setCurrentSession(session) {
      if (currentSession) endSession(currentSession);
      currentSession = session;
    },
    getCurrentSession: () => currentSession,
    constants: { WATCHED_THRESHOLD, AUTO_ADVANCE_THRESHOLD, MAX_CONSECUTIVE_FAILURES },
  },
};
