const { getItemFull } = require('./plex');
const { toWindowsPath } = require('./pathmap');
const { monitorPlayback } = require('./playback-monitor');

const PLAYER_AGENT_URL = process.env.PLAYER_AGENT_URL;

if (!PLAYER_AGENT_URL) {
  throw new Error('PLAYER_AGENT_URL must be set (add-on option) - e.g. http://<media-pc-ip>:7777');
}

class PlayError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

async function playItem(itemId) {
  const item = await getItemFull(itemId);
  const plexPath = item?.Media?.[0]?.Part?.[0]?.file;

  if (!plexPath) {
    throw new PlayError('No playable file path returned by Plex for this item.');
  }

  let windowsPath;
  try {
    windowsPath = toWindowsPath(plexPath);
  } catch (err) {
    throw new PlayError(err.message);
  }

  let response;
  try {
    response = await fetch(`${PLAYER_AGENT_URL}/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: windowsPath }),
    });
  } catch {
    throw new PlayError("Media PC isn't reachable - is it turned on?");
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new PlayError(body.error || `player-agent returned ${response.status}`);
  }

  monitorPlayback(item);

  return { path: windowsPath };
}

module.exports = { playItem, PlayError };
