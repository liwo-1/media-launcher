'use strict';

const { createActiveProvider } = require('./provider-manager');
const { resolveMediaPath } = require('./pathmap');
const { monitorPlayback } = require('./playback-monitor');
const {
  AgentRequestError,
  createSession: createAgentSession,
  resolvePlaybackTarget,
} = require('./agent-client');

class PlayError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function defaultDependencies() {
  return {
    resolvePlaybackTarget,
    resolveMediaPath,
    createAgentSession,
    monitorPlayback,
  };
}

function resolveTarget(requestedTargetId, dependencies) {
  try {
    return dependencies.resolvePlaybackTarget(requestedTargetId);
  } catch (error) {
    throw new PlayError(error.message, error.status || 400);
  }
}

async function launchResolvedPlayback(
  playback,
  provider,
  requestedTargetId = '',
  dependencies = defaultDependencies()
) {
  if (!provider || playback?.item?.provider !== provider.kind || !playback?.sourcePath) {
    throw new PlayError('The media provider returned an invalid playback source.', 502);
  }

  const target = resolveTarget(requestedTargetId, dependencies);
  let targetPath;
  try {
    targetPath = dependencies.resolveMediaPath(playback.sourcePath, target.agent);
  } catch (error) {
    throw new PlayError(error.message, 400);
  }

  let launched;
  try {
    launched = await dependencies.createAgentSession(target, {
      path: targetPath,
      title: playback.item.title || '',
      startPositionMs: playback.resumePositionMs || 0,
    });
  } catch (error) {
    if (error instanceof AgentRequestError) throw new PlayError(error.message, error.status);
    throw new PlayError(error.message || `${target.agent.name} could not start playback.`);
  }

  const capabilities = new Set(target.player.capabilities);
  const canMonitor =
    capabilities.has('status.state') &&
    capabilities.has('status.position') &&
    capabilities.has('status.duration');
  if (canMonitor) dependencies.monitorPlayback(playback, provider, target, launched, targetPath);

  return {
    targetId: target.id,
    sessionId: launched.sessionId || undefined,
  };
}

async function playItem(itemId, requestedTargetId = '') {
  let provider;
  let playback;
  try {
    provider = createActiveProvider();
    playback = await provider.resolvePlayback(itemId);
  } catch (error) {
    throw new PlayError(error.message, error.status || 502);
  }
  return launchResolvedPlayback(playback, provider, requestedTargetId);
}

module.exports = { launchResolvedPlayback, playItem, PlayError, _test: { defaultDependencies } };
