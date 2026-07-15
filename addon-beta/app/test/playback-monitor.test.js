'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = path.join(os.tmpdir(), `media-launcher-monitor-test-${process.pid}`);
const {
  cancelProviderSessions,
  cancelTargetSession,
  finalizeTargetSession,
  listPlaybackSessions,
  monitorPlayback,
  _test,
} = require('../src/playback-monitor');

function playback(id, kind = 'episode', providerKind = 'plex') {
  return {
    item: { id: String(id), provider: providerKind, kind, title: `Item ${id}` },
    sourcePath: `/media/${id}.mkv`,
    resumePositionMs: 0,
    context: { provider: providerKind, itemId: String(id), kind },
  };
}

function provider(kind = 'plex') {
  return { kind };
}

function createHarness(statuses, nextPlayback = null) {
  const calls = { progress: [], watched: [], played: [], playedTargets: [], playedProviders: [] };
  return {
    calls,
    dependencies: {
      getPlayerStatus: async () => {
        const value = statuses.shift();
        if (value instanceof Error) throw value;
        return value;
      },
      reportProgress: async (...args) => calls.progress.push(args),
      setWatched: async (...args) => calls.watched.push(args),
      getNextPlayable: async () => nextPlayback,
      playResolved: async (next, capturedProvider, targetId) => {
        calls.played.push(next.item.id);
        calls.playedTargets.push(targetId);
        calls.playedProviders.push(capturedProvider);
      },
      now: () => Date.now(),
    },
  };
}

test('marks watched at the threshold but does not advance while still playing', async () => {
  const capturedProvider = provider();
  const session = _test.createSession(playback('10'), capturedProvider);
  _test.setCurrentSession(session);
  const harness = createHarness([{ state: 2, position: 91, duration: 100 }], playback('11'));

  await _test.pollOnce(session, harness.dependencies);

  assert.equal(harness.calls.watched.length, 1);
  assert.equal(harness.calls.watched[0][0], capturedProvider);
  assert.equal(harness.calls.watched[0][1].item.id, '10');
  assert.deepEqual(harness.calls.played, []);
  assert.equal(_test.getCurrentSession(), session);
});

test('retries a failed watched update on the next poll', async () => {
  const session = _test.createSession(playback('10'), provider());
  _test.setCurrentSession(session);
  const harness = createHarness([
    { state: 'playing', position: 91, duration: 100 },
    { state: 'playing', position: 92, duration: 100 },
  ]);
  let watchedAttempts = 0;
  harness.dependencies.setWatched = async () => {
    watchedAttempts += 1;
    if (watchedAttempts === 1) throw new Error('temporary provider failure');
  };

  await _test.pollOnce(session, harness.dependencies);
  assert.equal(session.markedWatched, false);
  await _test.pollOnce(session, harness.dependencies);

  assert.equal(watchedAttempts, 2);
  assert.equal(session.markedWatched, true);
  _test.endSession(session);
});

test('advances only after a near-end transition to stopped', async () => {
  const capturedProvider = provider();
  const session = _test.createSession(playback('10'), capturedProvider);
  _test.setCurrentSession(session);
  const harness = createHarness(
    [
      { state: 2, position: 95, duration: 100 },
      { state: 0, position: 96, duration: 100 },
    ],
    playback('11')
  );

  await _test.pollOnce(session, harness.dependencies);
  assert.deepEqual(harness.calls.played, []);
  await _test.pollOnce(session, harness.dependencies);

  assert.deepEqual(harness.calls.played, ['11']);
  assert.equal(_test.getCurrentSession(), null);
});

test('reports stopped and advances when the player clears duration at the end', async () => {
  const session = _test.createSession(playback('10'), provider());
  _test.setCurrentSession(session);
  const harness = createHarness(
    [
      { state: 2, position: 95, duration: 100 },
      { state: 0, position: 0, duration: 0 },
    ],
    playback('11')
  );

  await _test.pollOnce(session, harness.dependencies);
  await _test.pollOnce(session, harness.dependencies);

  assert.deepEqual(harness.calls.played, ['11']);
  assert.equal(harness.calls.progress.at(-1)[2].state, 'stopped');
  assert.equal(harness.calls.progress.at(-1)[2].positionMs, 95);
  assert.equal(harness.calls.progress.at(-1)[2].durationMs, 100);
});

test('ends after two initial stopped samples without treating stale near-end state as completion', async () => {
  const session = _test.createSession(playback('10'), provider());
  _test.setCurrentSession(session);
  const harness = createHarness([
    { state: 'stopped', position: 95, duration: 100 },
    { state: 'stopped', position: 95, duration: 100 },
  ], playback('11'));

  await _test.pollOnce(session, harness.dependencies);
  assert.equal(_test.getCurrentSession(), session, 'one stopped sample allows for player startup');
  await _test.pollOnce(session, harness.dependencies);

  assert.equal(_test.getCurrentSession(), null);
  assert.deepEqual(harness.calls.played, []);
  assert.deepEqual(harness.calls.progress, []);
  assert.deepEqual(harness.calls.watched, []);
});

test('cancels the prior session when a new session becomes current', () => {
  const capturedProvider = provider();
  const first = _test.createSession(playback('1'), capturedProvider);
  const second = _test.createSession(playback('2'), capturedProvider);
  _test.setCurrentSession(first);
  _test.setCurrentSession(second);
  assert.equal(first.cancelled, true);
  assert.equal(_test.getCurrentSession(), second);
});

test('ends a session after three consecutive status failures', async () => {
  const session = _test.createSession(playback('10'), provider());
  _test.setCurrentSession(session);
  const harness = createHarness([new Error('offline'), new Error('offline'), new Error('offline')]);

  await _test.pollOnce(session, harness.dependencies);
  await _test.pollOnce(session, harness.dependencies);
  assert.equal(_test.getCurrentSession(), session);
  await _test.pollOnce(session, harness.dependencies);
  assert.equal(_test.getCurrentSession(), null);
});

test('ends monitoring when the player reports a different full media path', async () => {
  const session = _test.createSession(
    playback('10'),
    provider(),
    { id: 'target-living-room', agent: { platform: 'windows' } },
    { sessionId: 'session-1', protocolVersion: 2 },
    '\\\\nas\\Movies\\Expected.mkv'
  );
  _test.setCurrentSession(session);
  const harness = createHarness([{
    file: '\\\\nas\\Movies\\SomethingElse.mkv',
    state: 'playing',
    position: 95,
    duration: 100,
  }]);

  await _test.pollOnce(session, harness.dependencies);
  assert.equal(_test.getCurrentSession('target-living-room'), null);
  assert.deepEqual(harness.calls.progress, []);
  assert.deepEqual(harness.calls.watched, []);
});

test('matches Windows status paths case-insensitively and accepts a basename status', () => {
  assert.equal(
    _test.statusMatchesExpectedPath('//NAS/Movies/Film.MKV', '\\\\nas\\movies\\film.mkv', 'windows'),
    true
  );
  assert.equal(
    _test.statusMatchesExpectedPath('Film.mkv', '\\\\nas\\Movies\\Film.mkv', 'windows'),
    true
  );
  assert.equal(
    _test.statusMatchesExpectedPath('Other.mkv', '\\\\nas\\Movies\\Film.mkv', 'windows'),
    false
  );
});

test('keeps independent sessions on different playback targets', () => {
  const capturedProvider = provider();
  const livingRoom = _test.createSession(playback('1'), capturedProvider, { id: 'target-living-room' });
  const bedroom = _test.createSession(playback('2'), capturedProvider, { id: 'target-bedroom' });

  _test.setCurrentSession(livingRoom);
  _test.setCurrentSession(bedroom);

  assert.equal(livingRoom.cancelled, false);
  assert.equal(_test.getCurrentSession('target-living-room'), livingRoom);
  assert.equal(_test.getCurrentSession('target-bedroom'), bedroom);
});

test('replacing playback cancels only the session on that same target', () => {
  const capturedProvider = provider();
  const firstLivingRoom = _test.createSession(playback('1'), capturedProvider, { id: 'target-living-room' });
  const bedroom = _test.createSession(playback('2'), capturedProvider, { id: 'target-bedroom' });
  const secondLivingRoom = _test.createSession(playback('3'), capturedProvider, { id: 'target-living-room' });
  _test.setCurrentSession(firstLivingRoom);
  _test.setCurrentSession(bedroom);
  _test.setCurrentSession(secondLivingRoom);

  assert.equal(firstLivingRoom.cancelled, true);
  assert.equal(bedroom.cancelled, false);
  assert.equal(_test.getCurrentSession('target-living-room'), secondLivingRoom);
});

test('switching players on one physical agent cancels its previous monitor', () => {
  const capturedProvider = provider();
  const mpc = _test.createSession(
    playback('1'),
    capturedProvider,
    { id: 'target-mpc', agent: { instanceId: 'agent-living-room' } }
  );
  const vlc = _test.createSession(
    playback('2'),
    capturedProvider,
    { id: 'target-vlc', agent: { instanceId: 'agent-living-room' } }
  );

  _test.setCurrentSession(mpc);
  _test.setCurrentSession(vlc);

  assert.equal(mpc.cancelled, true);
  assert.equal(vlc.cancelled, false);
  assert.equal(_test.getCurrentSession('target-mpc'), null);
  assert.equal(_test.getCurrentSession('target-vlc'), vlc);
});

test('cancels every session owned by one provider without affecting another provider', () => {
  for (const session of _test.getCurrentSessions().values()) _test.endSession(session);

  const livingRoom = _test.createSession(
    playback('1'),
    provider('plex'),
    { id: 'target-living-room' }
  );
  const bedroom = _test.createSession(
    playback('2'),
    provider('plex'),
    { id: 'target-bedroom' }
  );
  const kitchen = _test.createSession(
    playback('3', 'episode', 'jellyfin'),
    provider('jellyfin'),
    { id: 'target-kitchen' }
  );
  _test.setCurrentSession(livingRoom);
  _test.setCurrentSession(bedroom);
  _test.setCurrentSession(kitchen);

  cancelProviderSessions('plex');

  assert.equal(livingRoom.cancelled, true);
  assert.equal(bedroom.cancelled, true);
  assert.equal(kitchen.cancelled, false);
  assert.equal(_test.getCurrentSession('target-living-room'), null);
  assert.equal(_test.getCurrentSession('target-bedroom'), null);
  assert.equal(_test.getCurrentSession('target-kitchen'), kitchen);

  _test.endSession(kitchen);
});

test('cancels only the matching target session after an explicit stop', () => {
  const livingRoom = _test.createSession(
    playback('1'),
    provider(),
    { id: 'target-living-room' },
    { sessionId: 'session-current', protocolVersion: 2 }
  );
  _test.setCurrentSession(livingRoom);

  assert.equal(cancelTargetSession('target-living-room', 'session-stale'), false);
  assert.equal(livingRoom.cancelled, false);
  assert.equal(cancelTargetSession('target-living-room', 'session-current'), true);
  assert.equal(livingRoom.cancelled, true);
  assert.equal(_test.getCurrentSession('target-living-room'), null);
});

test('never auto-advances a session stopped by an explicit command', async () => {
  const session = _test.createSession(playback('10'), provider());
  _test.setCurrentSession(session);
  const harness = createHarness(
    [
      { state: 'playing', position: 95, duration: 100 },
      {
        state: 'stopped',
        position: 96,
        duration: 100,
        endReason: 'stopped-by-request',
      },
    ],
    playback('11')
  );

  await _test.pollOnce(session, harness.dependencies);
  await _test.pollOnce(session, harness.dependencies);

  assert.equal(_test.getCurrentSession(), null);
  assert.deepEqual(harness.calls.played, []);
  assert.equal(harness.calls.progress.at(-1)[2].state, 'stopped');
  assert.equal(harness.calls.watched.length, 1);
});

test('never auto-advances a session replaced by another launch', async () => {
  const session = _test.createSession(playback('10'), provider());
  _test.setCurrentSession(session);
  const harness = createHarness(
    [
      { state: 'playing', position: 95, duration: 100 },
      { state: 'stopped', position: 96, duration: 100, endReason: 'replaced' },
    ],
    playback('11')
  );

  await _test.pollOnce(session, harness.dependencies);
  await _test.pollOnce(session, harness.dependencies);

  assert.equal(_test.getCurrentSession(), null);
  assert.deepEqual(harness.calls.played, []);
  assert.equal(harness.calls.progress.at(-1)[2].state, 'stopped');
  assert.equal(harness.calls.watched.length, 1);
});

test('explicit finalization records terminal progress and watched state before removal', async () => {
  const target = { id: 'target-living-room' };
  const session = _test.createSession(
    playback('10'),
    provider(),
    target,
    { sessionId: 'session-current', protocolVersion: 2 }
  );
  _test.setCurrentSession(session);
  const harness = createHarness([{ state: 'playing', position: 50, duration: 100 }]);
  await _test.pollOnce(session, harness.dependencies);

  const finalized = await finalizeTargetSession(target.id, 'session-current', {
    dependencies: harness.dependencies,
    status: { state: 'stopped', position: 96, duration: 100 },
    refreshStatus: false,
  });

  assert.equal(finalized, true);
  assert.equal(_test.getCurrentSession(target.id), null);
  assert.deepEqual(harness.calls.progress.at(-1)[2], {
    state: 'stopped',
    positionMs: 96,
    durationMs: 100,
  });
  assert.equal(harness.calls.watched.length, 1);
});

test('terminal provider updates retry once before the monitor is removed', async () => {
  const target = { id: 'target-living-room' };
  const session = _test.createSession(
    playback('10'),
    provider(),
    target,
    { sessionId: 'session-current', protocolVersion: 2 }
  );
  session.seenActive = true;
  session.lastState = 'playing';
  _test.setCurrentSession(session);
  const harness = createHarness([]);
  let progressAttempts = 0;
  let watchedAttempts = 0;
  harness.dependencies.reportProgress = async () => {
    progressAttempts += 1;
    if (progressAttempts === 1) throw new Error('temporary progress failure');
  };
  harness.dependencies.setWatched = async () => {
    watchedAttempts += 1;
    if (watchedAttempts === 1) throw new Error('temporary watched failure');
  };

  await finalizeTargetSession(target.id, 'session-current', {
    dependencies: harness.dependencies,
    status: { state: 'stopped', position: 96, duration: 100 },
    refreshStatus: false,
  });

  assert.equal(progressAttempts, 2);
  assert.equal(watchedAttempts, 2);
  assert.equal(session.markedWatched, true);
  assert.equal(_test.getCurrentSession(target.id), null);
});

test('replacement finalizes the old provider session and keeps the new monitor current', async () => {
  const physicalAgent = {
    instanceId: 'a'.repeat(32),
    name: 'Living Room',
    platform: 'windows',
  };
  const firstTarget = {
    id: 'target-mpc',
    agent: physicalAgent,
    player: { name: 'MPC-HC', capabilities: ['control.stop'] },
  };
  const secondTarget = {
    id: 'target-vlc',
    agent: physicalAgent,
    player: { name: 'VLC', capabilities: ['control.stop'] },
  };
  const capturedProvider = provider();
  const first = _test.createSession(
    playback('10'),
    capturedProvider,
    firstTarget,
    { sessionId: 'session-old', protocolVersion: 2 },
    '/media/10.mkv'
  );
  first.seenActive = true;
  first.lastState = 'playing';
  first.lastPositionMs = 90;
  first.lastDurationMs = 100;
  first.lastFraction = 0.9;
  _test.setCurrentSession(first);
  const harness = createHarness([{
    file: '/media/10.mkv',
    state: 'stopped',
    position: 96,
    duration: 100,
    endReason: 'replaced',
  }]);

  const second = monitorPlayback(
    playback('11'),
    capturedProvider,
    secondTarget,
    { sessionId: 'session-new', protocolVersion: 2 },
    '/media/11.mkv',
    harness.dependencies
  );
  await first.finalizationPromise;

  assert.equal(first.cancelled, true);
  assert.equal(_test.getCurrentSession(physicalAgent.instanceId), second);
  assert.equal(harness.calls.progress.at(-1)[2].state, 'stopped');
  assert.equal(harness.calls.watched.length, 1);
  _test.endSession(second);
});

test('public playback sessions are agent-keyed and omit private monitor state', () => {
  const rawInstanceId = 'b'.repeat(32);
  const session = _test.createSession(
    playback('private-item'),
    { kind: 'plex', secret: 'provider-secret' },
    {
      id: 'target-living-room',
      agent: {
        instanceId: rawInstanceId,
        name: 'Living Room',
        platform: 'windows',
        secret: 'agent-secret',
      },
      player: {
        name: 'VLC',
        capabilities: ['play.file', 'status.state', 'control.pause', 'control.stop'],
      },
    },
    { sessionId: 'session-public', protocolVersion: 2 },
    '/private/media/file.mkv'
  );
  session.lastState = 'playing';
  session.lastPositionMs = 12;
  session.lastDurationMs = 100;
  session.playback.item.title = 'Visible title';
  _test.setCurrentSession(session);

  const publicSession = listPlaybackSessions().find(
    (candidate) => candidate.sessionId === 'session-public'
  );
  const serialized = JSON.stringify(publicSession);
  assert.ok(publicSession);
  assert.match(publicSession.agentId, /^agent-[a-f0-9]{24}$/);
  assert.notEqual(publicSession.agentId, rawInstanceId);
  assert.deepEqual(publicSession.capabilities, ['control.pause', 'control.stop']);
  assert.doesNotMatch(serialized, /private-item|private\/media|provider-secret|agent-secret/);
  _test.endSession(session);
});

test('auto-next preserves both playback target and captured provider after settings switch', async () => {
  const capturedProvider = provider('plex');
  const session = _test.createSession(
    playback('10'),
    capturedProvider,
    { id: 'target-living-room' }
  );
  _test.setCurrentSession(session);
  const harness = createHarness(
    [
      { state: 'playing', position: 95, duration: 100 },
      { state: 'stopped', position: 96, duration: 100 },
    ],
    playback('11')
  );

  // A settings change could create a Jellyfin provider for new playback, but this session owns Plex.
  const newlyActiveProvider = provider('jellyfin');
  assert.notEqual(capturedProvider, newlyActiveProvider);
  await _test.pollOnce(session, harness.dependencies);
  await _test.pollOnce(session, harness.dependencies);

  assert.deepEqual(harness.calls.playedTargets, ['target-living-room']);
  assert.equal(harness.calls.playedProviders[0], capturedProvider);
});
