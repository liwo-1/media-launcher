const { getItemFull } = require('./plex');
const { toWindowsPath } = require('./pathmap');
const { monitorPlayback } = require('./playback-monitor');
const { getPlayerAgentUrl, getPlayerAgentHeaders } = require('./agent-config');

class PlayError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

async function playItem(itemId) {
  const playerAgentUrl = getPlayerAgentUrl();
  if (!playerAgentUrl) {
    throw new PlayError('Player agent URL is not configured yet - set it on the Settings page.', 400);
  }

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
    response = await fetch(`${playerAgentUrl}/play`, {
      method: 'POST',
      headers: getPlayerAgentHeaders({ 'Content-Type': 'application/json' }),
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
