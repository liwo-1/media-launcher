const { getItemFull } = require('./plex');
const { resolveMediaPath } = require('./pathmap');
const { monitorPlayback } = require('./playback-monitor');
const {
  AgentRequestError,
  createSession,
  resolvePlaybackTarget,
} = require('./agent-client');

class PlayError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

async function playItem(itemId, requestedTargetId = '') {
  let target;
  try {
    target = resolvePlaybackTarget(requestedTargetId);
  } catch (err) {
    throw new PlayError(err.message, err.status || 400);
  }

  const item = await getItemFull(itemId);
  const sourcePath = item?.Media?.[0]?.Part?.[0]?.file;
  if (!sourcePath) throw new PlayError('No playable file path returned by Plex for this item.');

  let targetPath;
  try {
    targetPath = resolveMediaPath(sourcePath, target.agent);
  } catch (err) {
    throw new PlayError(err.message, 400);
  }

  let launched;
  try {
    launched = await createSession(target, {
      path: targetPath,
      title: item.title || '',
      startPositionMs: item.viewOffset || 0,
    });
  } catch (err) {
    if (err instanceof AgentRequestError) throw new PlayError(err.message, err.status);
    throw new PlayError(err.message || `${target.agent.name} could not start playback.`);
  }

  const capabilities = new Set(target.player.capabilities);
  const canMonitor =
    capabilities.has('status.state') &&
    capabilities.has('status.position') &&
    capabilities.has('status.duration');
  if (canMonitor) monitorPlayback(item, target, launched, targetPath);

  return {
    targetId: target.id,
    sessionId: launched.sessionId || undefined,
  };
}

module.exports = { playItem, PlayError };
