'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { createAcceptanceRecord, getReleaseInfo, parseArguments } = require('./release-info');

const root = path.resolve(__dirname, '..');

test('derives prerelease assets from checked-in version metadata', () => {
  const info = getReleaseInfo(root, { expectedAppVersion: '2.0.0-beta.1' });
  assert.deepEqual(info, {
    appVersion: '2.0.0-beta.1',
    windowsAgentVersion: '1.5.0-beta.1',
    linuxAgentVersion: '0.1.0-beta.1',
    stableVersion: '2.0.0',
    tag: 'v2.0.0-beta.1',
    windowsAgentAsset: 'MediaLauncherPlayerAgent-1.5.0-beta.1-win-x64.exe',
    linuxX64Asset: 'MediaLauncherLinuxAgent-0.1.0-beta.1-linux-x64.tar.gz',
    linuxArm64Asset: 'MediaLauncherLinuxAgent-0.1.0-beta.1-linux-arm64.tar.gz',
    checksumAsset: 'SHA256SUMS.txt',
    acceptanceAsset: 'acceptance-2.0.0-beta.1.json',
  });
  assert.throws(
    () => getReleaseInfo(root, { expectedAppVersion: '2.0.0-beta.2' }),
    /does not match beta metadata/
  );
});

test('generates a fail-closed acceptance record tied to the release commit', () => {
  const info = getReleaseInfo(root);
  const record = createAcceptanceRecord(info, 'a'.repeat(40));
  assert.equal(record.candidateVersion, info.appVersion);
  assert.equal(record.candidateCommit, 'a'.repeat(40));
  assert.equal(record.targetVersion, info.stableVersion);
  assert.deepEqual(record.artifacts, {
    windows: {
      version: info.windowsAgentVersion,
      assets: [info.windowsAgentAsset],
    },
    linux: {
      version: info.linuxAgentVersion,
      assets: [info.linuxX64Asset, info.linuxArm64Asset],
    },
  });
  assert.deepEqual(Object.keys(record.checks), ['homeAssistant', 'windows', 'linux']);
  assert.equal(Object.values(record.checks).every((check) => check.passed === false), true);
  assert.match(record.checks.homeAssistant.notes, /two paired agents.*Plex and Jellyfin movies and episodes/);
  assert.match(
    record.checks.windows.notes,
    /exact published Windows asset.*MPC-HC verify resume\/progress and auto-advance.*pause\/resume, seek, stop/
  );
  assert.match(record.checks.linux.notes, /x64 and arm64.*mpv and VLC\/MPRIS.*symlink rejection/);
});

test('release-info arguments reject ambiguous or missing values', () => {
  assert.deepEqual(parseArguments([
    '--expect-app', '2.0.0-beta.1',
    '--commit', 'a'.repeat(40),
  ]), { expectApp: '2.0.0-beta.1', commit: 'a'.repeat(40) });
  assert.throws(() => parseArguments(['--unknown', 'x']), /Unknown/);
  assert.throws(() => parseArguments(['--commit']), /requires a value/);
});
