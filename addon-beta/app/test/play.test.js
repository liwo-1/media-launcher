'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { launchResolvedPlayback } = require('../src/play');

function descriptor(provider = 'plex') {
  return {
    item: { id: 'item-1', provider, kind: 'movie', title: 'Example' },
    sourcePath: '/server/Movies/Example.mkv',
    resumePositionMs: 12345,
    context: { provider, itemId: 'item-1' },
  };
}

test('launches a private provider path on the selected target and captures that provider for monitoring', async () => {
  const playback = descriptor();
  const provider = Object.freeze({ kind: 'plex' });
  const target = {
    id: 'target-1',
    agent: { name: 'Living Room', platform: 'windows' },
    player: {
      capabilities: ['play.file', 'status.state', 'status.position', 'status.duration'],
    },
  };
  const calls = [];
  const result = await launchResolvedPlayback(playback, provider, 'target-1', {
    resolvePlaybackTarget: (targetId) => {
      calls.push(['target', targetId]);
      return target;
    },
    resolveMediaPath: (sourcePath, agent) => {
      calls.push(['path', sourcePath, agent]);
      return '\\\\nas\\Movies\\Example.mkv';
    },
    createAgentSession: async (...args) => {
      calls.push(['launch', ...args]);
      return { sessionId: 'session-1', protocolVersion: 2 };
    },
    monitorPlayback: (...args) => calls.push(['monitor', ...args]),
  });

  assert.deepEqual(result, { targetId: 'target-1', sessionId: 'session-1' });
  const launch = calls.find((call) => call[0] === 'launch');
  assert.deepEqual(launch[2], {
    path: '\\\\nas\\Movies\\Example.mkv',
    title: 'Example',
    startPositionMs: 12345,
  });
  const monitor = calls.find((call) => call[0] === 'monitor');
  assert.equal(monitor[1], playback);
  assert.equal(monitor[2], provider);
  assert.equal(monitor[3], target);
  assert.equal(monitor[5], '\\\\nas\\Movies\\Example.mkv');
});

test('rejects a descriptor from a different provider before resolving a playback target', async () => {
  let resolved = false;
  await assert.rejects(
    launchResolvedPlayback(descriptor('jellyfin'), { kind: 'plex' }, '', {
      resolvePlaybackTarget: () => { resolved = true; },
    }),
    (error) => error.status === 502 && /invalid playback source/.test(error.message)
  );
  assert.equal(resolved, false);
});
