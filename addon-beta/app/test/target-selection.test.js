const assert = require('node:assert/strict');
const test = require('node:test');

const { decidePlaybackTarget } = require('../public/target-selection');

function target(id, online) {
  return { id, online, name: id, capabilities: ['play.file'] };
}

test('never silently switches away from an offline configured default', () => {
  const result = decidePlaybackTarget({
    targets: [target('living-room', false), target('bedroom', true)],
    defaultPlaybackTargetId: 'living-room',
    alwaysAskPlaybackTarget: false,
  });
  assert.equal(result.action, 'pick');
});

test('never silently switches when the configured default is no longer advertised', () => {
  const result = decidePlaybackTarget({
    targets: [target('bedroom', true)],
    defaultPlaybackTargetId: 'missing-living-room',
    alwaysAskPlaybackTarget: false,
  });
  assert.equal(result.action, 'pick');
});

test('uses one online target when no different default is configured', () => {
  const only = target('living-room', true);
  const result = decidePlaybackTarget({
    targets: [only],
    defaultPlaybackTargetId: '',
    alwaysAskPlaybackTarget: true,
  });
  assert.equal(result.action, 'target');
  assert.equal(result.target, only);
});

test('uses an online default only when always-ask is disabled', () => {
  const targets = [target('living-room', true), target('bedroom', true)];
  assert.equal(decidePlaybackTarget({
    targets,
    defaultPlaybackTargetId: 'bedroom',
    alwaysAskPlaybackTarget: false,
  }).target.id, 'bedroom');
  assert.equal(decidePlaybackTarget({
    targets,
    defaultPlaybackTargetId: 'bedroom',
    alwaysAskPlaybackTarget: true,
  }).action, 'pick');
});

test('reports no-target and all-offline states separately', () => {
  assert.match(decidePlaybackTarget({ targets: [] }).message, /No playback targets/);
  assert.match(decidePlaybackTarget({ targets: [target('living-room', false)] }).message, /offline/);
});
