// Polls the media PC's player-agent (which in turn reads MPC-HC's Web Interface) after a
// successful Play, so we can (a) report progress back to Plex - making "Continue Watching" and
// per-show watched counts accurate for things played through this launcher, not just Plex's own
// apps - and (b) auto-advance to the next episode when one finishes naturally.
//
// NOT YET VERIFIED end-to-end - depends on MPC-HC's Web Interface being enabled on the media PC
// (a manual one-time setting change) and mpc-status.js's field-name assumptions holding up. Test
// this against a real playback session before relying on it.

const plex = require('./plex');

const POLL_INTERVAL_MS = 10000;
const WATCHED_THRESHOLD = 0.9; // matches standard Plex/client convention for "counts as watched"
const MAX_POLL_DURATION_MS = 6 * 60 * 60 * 1000; // safety cap so a stuck poll can't run forever

const PLAYER_AGENT_URL = process.env.PLAYER_AGENT_URL;

async function getPlayerStatus() {
  const response = await fetch(`${PLAYER_AGENT_URL}/status`);
  if (!response.ok) {
    throw new Error(`player-agent /status returned ${response.status}`);
  }
  return response.json();
}

async function findNextEpisode(item) {
  if (item.type !== 'episode') return null;
  const episodes = await plex.getEpisodes(item.parentRatingKey);
  const sorted = [...episodes].sort((a, b) => a.index - b.index);
  const currentIdx = sorted.findIndex((e) => String(e.ratingKey) === String(item.ratingKey));
  if (currentIdx === -1 || currentIdx === sorted.length - 1) return null;
  return sorted[currentIdx + 1];
}

function monitorPlayback(item) {
  const startedAt = Date.now();
  let markedWatched = false;

  const interval = setInterval(async () => {
    if (Date.now() - startedAt > MAX_POLL_DURATION_MS) {
      clearInterval(interval);
      return;
    }

    let status;
    try {
      status = await getPlayerStatus();
    } catch {
      clearInterval(interval);
      return;
    }

    if (!status.duration) return;

    const fraction = status.position / status.duration;
    const state = status.state === 2 ? 'playing' : status.state === 1 ? 'paused' : 'stopped';

    try {
      await plex.reportTimeline(item.ratingKey, state, status.position, status.duration);
    } catch {
      // best-effort - a Plex hiccup shouldn't stop the monitor
    }

    if (!markedWatched && fraction >= WATCHED_THRESHOLD) {
      markedWatched = true;
      try {
        await plex.markWatched(item.ratingKey);
      } catch {
        // best-effort
      }

      const nextEpisode = await findNextEpisode(item).catch(() => null);
      if (nextEpisode) {
        clearInterval(interval);
        const { playItem } = require('./play'); // lazy require, avoids circular load at startup
        await playItem(nextEpisode.ratingKey).catch(() => {});
        return;
      }
    }

    if (status.state === 0 && fraction < WATCHED_THRESHOLD) {
      // Stopped before finishing - user closed early. Don't mark watched, don't advance.
      clearInterval(interval);
    }
  }, POLL_INTERVAL_MS);
}

module.exports = { monitorPlayback };
