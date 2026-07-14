const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = path.join(os.tmpdir(), `media-launcher-monitor-test-${process.pid}`);
const { _test } = require('../src/playback-monitor');

function createHarness(statuses, nextEpisode = null) {
  const calls = { timeline: [], watched: [], played: [] };
  return {
    calls,
    dependencies: {
      getPlayerStatus: async () => {
        const value = statuses.shift();
        if (value instanceof Error) throw value;
        return value;
      },
      reportTimeline: async (...args) => calls.timeline.push(args),
      markWatched: async (...args) => calls.watched.push(args),
      findNextEpisode: async () => nextEpisode,
      playItem: async (ratingKey) => calls.played.push(ratingKey),
      now: () => Date.now(),
    },
  };
}

test('marks watched at the threshold but does not advance while still playing', async () => {
  const session = _test.createSession({ ratingKey: '10', type: 'episode', parentRatingKey: '2' });
  _test.setCurrentSession(session);
  const harness = createHarness([{ state: 2, position: 91, duration: 100 }], { ratingKey: '11' });

  await _test.pollOnce(session, harness.dependencies);

  assert.deepEqual(harness.calls.watched, [['10']]);
  assert.deepEqual(harness.calls.played, []);
  assert.equal(_test.getCurrentSession(), session);
});

test('advances only after a near-end transition to stopped', async () => {
  const session = _test.createSession({ ratingKey: '10', type: 'episode', parentRatingKey: '2' });
  _test.setCurrentSession(session);
  const harness = createHarness(
    [
      { state: 2, position: 95, duration: 100 },
      { state: 0, position: 96, duration: 100 },
    ],
    { ratingKey: '11' }
  );

  await _test.pollOnce(session, harness.dependencies);
  assert.deepEqual(harness.calls.played, []);
  await _test.pollOnce(session, harness.dependencies);

  assert.deepEqual(harness.calls.played, ['11']);
  assert.equal(_test.getCurrentSession(), null);
});

test('advances when MPC-HC clears duration as it transitions to stopped', async () => {
  const session = _test.createSession({ ratingKey: '10', type: 'episode', parentRatingKey: '2' });
  _test.setCurrentSession(session);
  const harness = createHarness(
    [
      { state: 2, position: 95, duration: 100 },
      { state: 0, position: 0, duration: 0 },
    ],
    { ratingKey: '11' }
  );

  await _test.pollOnce(session, harness.dependencies);
  await _test.pollOnce(session, harness.dependencies);

  assert.deepEqual(harness.calls.played, ['11']);
});

test('cancels the prior session when a new session becomes current', () => {
  const first = _test.createSession({ ratingKey: '1' });
  const second = _test.createSession({ ratingKey: '2' });
  _test.setCurrentSession(first);
  _test.setCurrentSession(second);
  assert.equal(first.cancelled, true);
  assert.equal(_test.getCurrentSession(), second);
});

test('ends a session after three consecutive status failures', async () => {
  const session = _test.createSession({ ratingKey: '10' });
  _test.setCurrentSession(session);
  const harness = createHarness([new Error('offline'), new Error('offline'), new Error('offline')]);

  await _test.pollOnce(session, harness.dependencies);
  await _test.pollOnce(session, harness.dependencies);
  assert.equal(_test.getCurrentSession(), session);
  await _test.pollOnce(session, harness.dependencies);
  assert.equal(_test.getCurrentSession(), null);
});
