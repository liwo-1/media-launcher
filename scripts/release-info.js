#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { betaVersion } = require('./promote-beta-to-stable');

const PRERELEASE_VERSION = /^\d+\.\d+\.\d+-[0-9A-Za-z][0-9A-Za-z.-]*$/;

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--expect-app', '--github-output', '--acceptance-output', '--commit'].includes(name)) {
      fail(`Unknown release-info argument: ${name}`);
    }
    if (!value || value.startsWith('--')) fail(`${name} requires a value`);
    result[name.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
  }
  return result;
}

function projectVersion(projectPath) {
  const source = fs.readFileSync(projectPath, 'utf8');
  const match = /<Version>([^<]+)<\/Version>/.exec(source);
  if (!match) fail(`No <Version> was found in ${projectPath}`);
  return match[1].trim();
}

function getReleaseInfo(root, { expectedAppVersion = '' } = {}) {
  const appVersion = betaVersion(path.join(root, 'addon-beta'));
  const windowsAgentVersion = projectVersion(path.join(root, 'player-agent-app', 'PlayerAgent.csproj'));
  const linuxAgentVersion = projectVersion(path.join(root, 'linux-agent', 'MediaLauncher.LinuxAgent.csproj'));
  if (!PRERELEASE_VERSION.test(windowsAgentVersion)) {
    fail(`Windows agent version '${windowsAgentVersion}' must be a semantic prerelease`);
  }
  if (!PRERELEASE_VERSION.test(linuxAgentVersion)) {
    fail(`Linux agent version '${linuxAgentVersion}' must be a semantic prerelease`);
  }
  if (expectedAppVersion && expectedAppVersion !== appVersion) {
    fail(`Requested prerelease '${expectedAppVersion}' does not match beta metadata '${appVersion}'`);
  }
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  if (!new RegExp(`^## ${appVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`, 'm').test(changelog)) {
    fail(`CHANGELOG.md has no release heading for ${appVersion}`);
  }
  return {
    appVersion,
    windowsAgentVersion,
    linuxAgentVersion,
    stableVersion: appVersion.slice(0, appVersion.indexOf('-')),
    tag: `v${appVersion}`,
    windowsAgentAsset: `MediaLauncherPlayerAgent-${windowsAgentVersion}-win-x64.exe`,
    linuxX64Asset: `MediaLauncherLinuxAgent-${linuxAgentVersion}-linux-x64.tar.gz`,
    linuxArm64Asset: `MediaLauncherLinuxAgent-${linuxAgentVersion}-linux-arm64.tar.gz`,
    checksumAsset: 'SHA256SUMS.txt',
    acceptanceAsset: `acceptance-${appVersion}.json`,
  };
}

function createAcceptanceRecord(info, commit) {
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) {
    fail('A 40-character lowercase commit is required for the acceptance record');
  }
  const notes = {
    homeAssistant: 'Fresh-install and upgrade the beta catalogue entry from main; recover Settings; ' +
      'with two paired agents and multiple players verify default/ask target selection; browse artwork and ' +
      'launch real Plex and Jellyfin movies and episodes.',
    windows: 'Install and upgrade the exact published Windows asset; pair, reset, and re-pair; discover ' +
      'MPC-HC, VLC, PotPlayer, and a custom profile where available; launch real media through every ' +
      'available player and verify replacement/ownership; with MPC-HC verify resume/progress and ' +
      'auto-advance; with VLC verify status/progress, pause/resume, seek, stop, and the explicit end reason.',
    linux: 'Install and upgrade the exact x64 and arm64 archives where hardware is available; verify the ' +
      'systemd user service restarts and pairs; launch through mpv and VLC/MPRIS; verify status/controls and ' +
      'allowed-root and symlink rejection.',
  };
  return {
    schemaVersion: 1,
    candidateVersion: info.appVersion,
    candidateCommit: commit,
    targetVersion: info.stableVersion,
    artifacts: {
      windows: {
        version: info.windowsAgentVersion,
        assets: [info.windowsAgentAsset],
      },
      linux: {
        version: info.linuxAgentVersion,
        assets: [info.linuxX64Asset, info.linuxArm64Asset],
      },
    },
    checks: Object.fromEntries(Object.entries(notes).map(([name, message]) => [name, {
      passed: false,
      testedBy: '',
      testedAt: '',
      notes: message,
    }])),
  };
}

function writeGithubOutput(filePath, info) {
  const lines = Object.entries({
    app_version: info.appVersion,
    windows_agent_version: info.windowsAgentVersion,
    linux_agent_version: info.linuxAgentVersion,
    stable_version: info.stableVersion,
    tag: info.tag,
    windows_agent_asset: info.windowsAgentAsset,
    linux_x64_asset: info.linuxX64Asset,
    linux_arm64_asset: info.linuxArm64Asset,
    checksum_asset: info.checksumAsset,
    acceptance_asset: info.acceptanceAsset,
  }).map(([name, value]) => `${name}=${value}`);
  fs.appendFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const root = path.resolve(__dirname, '..');
  const info = getReleaseInfo(root, { expectedAppVersion: options.expectApp });
  if (options.githubOutput) writeGithubOutput(options.githubOutput, info);
  if (options.acceptanceOutput) {
    const record = createAcceptanceRecord(info, options.commit || '');
    fs.writeFileSync(options.acceptanceOutput, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(info));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Prerelease validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { createAcceptanceRecord, getReleaseInfo, parseArguments, projectVersion };
