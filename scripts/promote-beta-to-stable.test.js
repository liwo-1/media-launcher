'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const {
  assertCliCandidateState,
  buildPromotedTree,
  expectedAcceptanceArtifacts,
  isStrictIsoUtcTimestamp,
  parseArguments,
  promote,
  treeDigest,
  validateAcceptance,
  validateVersionPair,
} = require('./promote-beta-to-stable');

const candidateVersion = '2.3.4-beta.5';
const targetVersion = '2.3.4';
const candidateCommit = 'a'.repeat(40);
const windowsAgentVersion = '1.7.1-beta.2';
const linuxAgentVersion = '0.4.0-beta.3';

function acceptanceArtifacts() {
  return {
    windows: {
      version: windowsAgentVersion,
      assets: [`MediaLauncherPlayerAgent-${windowsAgentVersion}-win-x64.exe`],
    },
    linux: {
      version: linuxAgentVersion,
      assets: [
        `MediaLauncherLinuxAgent-${linuxAgentVersion}-linux-x64.tar.gz`,
        `MediaLauncherLinuxAgent-${linuxAgentVersion}-linux-arm64.tar.gz`,
      ],
    },
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeAcceptance(overrides = {}) {
  return {
    schemaVersion: 1,
    candidateVersion,
    candidateCommit,
    targetVersion,
    artifacts: acceptanceArtifacts(),
    checks: Object.fromEntries(['homeAssistant', 'windows', 'linux'].map((name) => [name, {
      passed: true,
      testedBy: 'Fixture Tester',
      testedAt: '2026-07-15T12:00:00Z',
    }])),
    ...overrides,
  };
}

function makeRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-launcher-promotion-test-'));
  const beta = path.join(root, 'addon-beta');
  fs.mkdirSync(path.join(beta, 'app'), { recursive: true });
  fs.writeFileSync(path.join(beta, 'config.yaml'), [
    'name: Media Launcher Beta',
    `version: "${candidateVersion}"`,
    'slug: media_launcher_beta',
    'description: BETA - fixture',
    'arch:',
    '  - amd64',
    'ingress: true',
    'ingress_port: 8088',
    'panel_title: Media Launcher Beta',
    'ports:',
    '  8088/tcp: 8089',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(beta, 'Dockerfile'), 'FROM node:20-alpine\n');
  fs.writeFileSync(path.join(beta, 'run.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(beta, 'app', 'server.js'), 'console.log("fixture");\n');
  writeJson(path.join(beta, 'app', 'package.json'), {
    name: 'media-launcher-app',
    version: candidateVersion,
  });
  writeJson(path.join(beta, 'app', 'package-lock.json'), {
    name: 'media-launcher-app',
    version: candidateVersion,
    lockfileVersion: 3,
    packages: { '': { name: 'media-launcher-app', version: candidateVersion } },
  });
  fs.mkdirSync(path.join(beta, 'app', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(beta, 'app', 'node_modules', 'private.txt'), 'excluded');
  fs.mkdirSync(path.join(beta, 'app', 'local-data'), { recursive: true });
  fs.writeFileSync(path.join(beta, 'app', 'local-data', 'settings.json'), '{"secret":"excluded"}');

  fs.mkdirSync(path.join(root, 'player-agent-app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'player-agent-app', 'PlayerAgent.csproj'),
    `<Project><PropertyGroup><Version>${windowsAgentVersion}</Version></PropertyGroup></Project>\n`);
  fs.mkdirSync(path.join(root, 'linux-agent'), { recursive: true });
  fs.writeFileSync(path.join(root, 'linux-agent', 'MediaLauncher.LinuxAgent.csproj'),
    `<Project><PropertyGroup><Version>${linuxAgentVersion}</Version></PropertyGroup></Project>\n`);

  fs.mkdirSync(path.join(root, 'addon'), { recursive: true });
  fs.writeFileSync(path.join(root, 'addon', 'old-stable.txt'), 'old');
  const acceptancePath = path.join(root, 'acceptance.json');
  writeJson(acceptancePath, makeAcceptance());
  return { root, beta, acceptancePath };
}

test('requires explicit confirmation before a writing promotion', () => {
  assert.deepEqual(parseArguments([
    '--version', targetVersion,
    '--acceptance', 'acceptance.json',
  ]), {
    version: targetVersion,
    acceptance: 'acceptance.json',
    write: false,
    confirm: '',
  });
  assert.throws(
    () => parseArguments([
      '--version', targetVersion,
      '--acceptance', 'acceptance.json',
      '--write',
    ]),
    /requires --confirm PROMOTE_BETA_TO_STABLE/
  );
});

test('acceptance is fail-closed for every manual platform gate and exact commit', () => {
  const options = {
    candidateVersion,
    targetVersion,
    currentCommit: candidateCommit,
    expectedArtifacts: acceptanceArtifacts(),
  };
  validateAcceptance(makeAcceptance(), options);
  const missingLinux = makeAcceptance();
  missingLinux.checks.linux.passed = false;
  assert.throws(
    () => validateAcceptance(missingLinux, options),
    /linux.*has not passed/
  );
  assert.throws(
    () => validateAcceptance(makeAcceptance(), {
      ...options,
      currentCommit: 'b'.repeat(40),
    }),
    /does not match HEAD/
  );
  assert.throws(() => validateVersionPair(candidateVersion, '2.3.5'), /must match candidate core/);
});

test('acceptance binds exact published versions and asset names', () => {
  const options = {
    candidateVersion,
    targetVersion,
    currentCommit: candidateCommit,
    expectedArtifacts: acceptanceArtifacts(),
  };
  const wrongVersion = makeAcceptance();
  wrongVersion.artifacts.windows.version = '1.7.1-beta.99';
  assert.throws(() => validateAcceptance(wrongVersion, options), /Windows version.*does not match/i);

  const wrongAsset = makeAcceptance();
  wrongAsset.artifacts.linux.assets[1] = 'renamed-or-unreviewed.tar.gz';
  assert.throws(() => validateAcceptance(wrongAsset, options), /Linux assets must exactly match/i);

  const unexpectedPlatform = makeAcceptance();
  unexpectedPlatform.artifacts.other = { version: '1.0.0', assets: ['other'] };
  assert.throws(() => validateAcceptance(unexpectedPlatform, options), /must contain exactly/i);
});

test('acceptance requires a real strict UTC ISO timestamp', () => {
  assert.equal(isStrictIsoUtcTimestamp('2026-07-15T12:00:00Z'), true);
  assert.equal(isStrictIsoUtcTimestamp('2026-07-15T12:00:00.12Z'), true);
  assert.equal(isStrictIsoUtcTimestamp('2026-07-15 12:00:00Z'), false);
  assert.equal(isStrictIsoUtcTimestamp('2026-07-15T14:00:00+02:00'), false);
  assert.equal(isStrictIsoUtcTimestamp('2026-02-30T12:00:00Z'), false);

  const invalid = makeAcceptance();
  invalid.checks.windows.testedAt = 'July 15, 2026';
  assert.throws(() => validateAcceptance(invalid, {
    candidateVersion,
    targetVersion,
    currentCommit: candidateCommit,
    expectedArtifacts: acceptanceArtifacts(),
  }), /real UTC ISO testedAt/);
});

test('derives the acceptance artifact identity from repository project versions', (t) => {
  const { root } = makeRepository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(expectedAcceptanceArtifacts(root), acceptanceArtifacts());
});

test('accepted candidate remains bound to every shipped runtime tree', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-launcher-candidate-tree-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runGit = (...args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim();
  runGit('init', '--initial-branch=main');
  runGit('config', 'user.name', 'Promotion Fixture');
  runGit('config', 'user.email', 'promotion@example.invalid');
  runGit('config', 'core.autocrlf', 'false');
  for (const directory of ['addon-beta', 'agent-core', 'player-agent-app', 'linux-agent', 'protocol']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(path.join(root, directory, 'fixture.txt'), `${directory} candidate\n`);
  }
  runGit('add', '.');
  runGit('commit', '-m', 'candidate');
  const acceptedCommit = runGit('rev-parse', 'HEAD');
  const acceptancePath = path.join(root, 'acceptance.json');
  writeJson(acceptancePath, { candidateCommit: acceptedCommit });

  fs.writeFileSync(path.join(root, 'README.md'), 'Unrelated release documentation change.\n');
  runGit('add', 'README.md');
  runGit('commit', '-m', 'documentation only');
  assert.doesNotThrow(() => assertCliCandidateState(root, acceptancePath, runGit('rev-parse', 'HEAD')));

  fs.writeFileSync(path.join(root, 'linux-agent', 'fixture.txt'), 'different shipped code\n');
  runGit('add', 'linux-agent/fixture.txt');
  runGit('commit', '-m', 'change accepted runtime');
  assert.throws(
    () => assertCliCandidateState(root, acceptancePath, runGit('rev-parse', 'HEAD')),
    /linux-agent changed after manual acceptance/
  );
});

test('builds the same sanitized stable tree from the same beta input', (t) => {
  const { root, beta } = makeRepository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'generated-one');
  const second = path.join(root, 'generated-two');
  const firstDigest = buildPromotedTree({ betaDirectory: beta, outputDirectory: first, targetVersion });
  const secondDigest = buildPromotedTree({ betaDirectory: beta, outputDirectory: second, targetVersion });

  assert.equal(firstDigest, secondDigest);
  assert.equal(firstDigest, treeDigest(first));
  const config = fs.readFileSync(path.join(first, 'config.yaml'), 'utf8');
  assert.match(config, /^name: Media Launcher$/m);
  assert.match(config, /^version: "2\.3\.4"$/m);
  assert.match(config, /^slug: media_launcher$/m);
  assert.match(config, /^  8088\/tcp: 8088$/m);
  assert.equal(JSON.parse(fs.readFileSync(path.join(first, 'app', 'package.json'))).version, targetVersion);
  assert.equal(fs.existsSync(path.join(first, 'app', 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(first, 'app', 'local-data')), false);
});

test('writing promotion replaces only the stable fixture and leaves beta untouched', (t) => {
  const { root, beta, acceptancePath } = makeRepository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const betaDigest = treeDigest(beta);
  const result = promote({
    root,
    targetVersion,
    acceptancePath,
    currentCommit: candidateCommit,
    write: true,
  });

  assert.equal(result.wrote, true);
  assert.equal(fs.existsSync(path.join(root, 'addon', 'old-stable.txt')), false);
  assert.equal(fs.existsSync(path.join(root, 'addon', 'app', 'server.js')), true);
  assert.equal(treeDigest(beta), betaDigest, 'promotion input must remain byte-for-byte unchanged');
  assert.equal(result.digest, treeDigest(path.join(root, 'addon')));
});
