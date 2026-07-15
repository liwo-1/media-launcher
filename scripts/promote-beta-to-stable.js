#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkCatalog } = require('./check-catalog');

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const PRERELEASE_VERSION = /^(\d+\.\d+\.\d+)-[0-9A-Za-z][0-9A-Za-z.-]*$/;
const REQUIRED_ACCEPTANCE_CHECKS = ['homeAssistant', 'windows', 'linux'];
const CANDIDATE_TREE_PATHS = [
  'addon-beta',
  'agent-core',
  'player-agent-app',
  'linux-agent',
  'protocol',
];
const EXCLUDED_SEGMENTS = new Set(['node_modules', 'local-data', 'bin', 'obj', '.git']);

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const values = { write: false, confirm: '' };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === '--write') {
      values.write = true;
      continue;
    }
    if (!['--version', '--acceptance', '--confirm'].includes(name)) {
      fail(`Unknown argument: ${name}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) fail(`${name} requires a value`);
    values[name.slice(2)] = value;
  }
  if (!values.version) fail('--version is required');
  if (!values.acceptance) fail('--acceptance is required');
  if (values.write && values.confirm !== 'PROMOTE_BETA_TO_STABLE') {
    fail('--write requires --confirm PROMOTE_BETA_TO_STABLE');
  }
  return values;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`Could not read JSON from ${filePath}: ${error.message}`);
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function yamlScalar(source, key) {
  const match = new RegExp(`^${key}:\\s*["']?([^"'\\r\\n]+)["']?\\s*$`, 'm').exec(source);
  return match ? match[1].trim() : '';
}

function betaVersion(betaDirectory) {
  const config = fs.readFileSync(path.join(betaDirectory, 'config.yaml'), 'utf8');
  const packageInfo = readJson(path.join(betaDirectory, 'app', 'package.json'));
  const lock = readJson(path.join(betaDirectory, 'app', 'package-lock.json'));
  const versions = [
    yamlScalar(config, 'version'),
    packageInfo.version,
    lock.version,
    lock.packages?.['']?.version,
  ];
  if (versions.some((value) => value !== versions[0])) {
    fail(`Beta version metadata is inconsistent: ${versions.join(', ')}`);
  }
  if (!PRERELEASE_VERSION.test(versions[0])) {
    fail(`Beta version must be a semantic prerelease; received '${versions[0]}'`);
  }
  return versions[0];
}

function validateVersionPair(candidateVersion, targetVersion) {
  const candidate = PRERELEASE_VERSION.exec(candidateVersion);
  if (!candidate) fail(`Candidate version '${candidateVersion}' is not a semantic prerelease`);
  if (!STABLE_VERSION.test(targetVersion)) {
    fail(`Stable version '${targetVersion}' must use major.minor.patch without a prerelease suffix`);
  }
  if (candidate[1] !== targetVersion) {
    fail(`Stable version '${targetVersion}' must match candidate core version '${candidate[1]}'`);
  }
}

function projectVersion(projectPath, label) {
  const source = fs.readFileSync(projectPath, 'utf8');
  const match = /<Version>([^<]+)<\/Version>/.exec(source);
  if (!match) fail(`No <Version> was found for ${label} in ${projectPath}`);
  const version = match[1].trim();
  if (!PRERELEASE_VERSION.test(version)) {
    fail(`${label} version '${version}' must be a semantic prerelease`);
  }
  return version;
}

function expectedAcceptanceArtifacts(root) {
  const windowsVersion = projectVersion(
    path.join(root, 'player-agent-app', 'PlayerAgent.csproj'),
    'Windows agent'
  );
  const linuxVersion = projectVersion(
    path.join(root, 'linux-agent', 'MediaLauncher.LinuxAgent.csproj'),
    'Linux agent'
  );
  return {
    windows: {
      version: windowsVersion,
      assets: [`MediaLauncherPlayerAgent-${windowsVersion}-win-x64.exe`],
    },
    linux: {
      version: linuxVersion,
      assets: [
        `MediaLauncherLinuxAgent-${linuxVersion}-linux-x64.tar.gz`,
        `MediaLauncherLinuxAgent-${linuxVersion}-linux-arm64.tar.gz`,
      ],
    },
  };
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} must contain exactly: ${wanted.join(', ')}`);
  }
}

function validateArtifacts(actual, expected) {
  assertExactKeys(actual, ['windows', 'linux'], 'Acceptance artifacts');
  for (const platform of ['windows', 'linux']) {
    assertExactKeys(actual[platform], ['version', 'assets'], `Acceptance ${platform} artifacts`);
    if (actual[platform].version !== expected[platform].version) {
      fail(`Acceptance ${platform} version '${actual[platform].version}' does not match ` +
        `candidate version '${expected[platform].version}'`);
    }
    if (!Array.isArray(actual[platform].assets) ||
        actual[platform].assets.length !== expected[platform].assets.length ||
        actual[platform].assets.some((asset, index) => asset !== expected[platform].assets[index])) {
      fail(`Acceptance ${platform} assets must exactly match: ${expected[platform].assets.join(', ')}`);
    }
  }
}

function isStrictIsoUtcTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const expected = `${match[1]}.${(match[2] || '').padEnd(3, '0')}Z`;
  return new Date(value).toISOString() === expected;
}

function validateAcceptance(value, {
  candidateVersion,
  targetVersion,
  currentCommit,
  expectedArtifacts,
}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Acceptance record must be an object');
  if (value.schemaVersion !== 1) fail('Acceptance record schemaVersion must be 1');
  if (value.candidateVersion !== candidateVersion) {
    fail(`Acceptance candidate '${value.candidateVersion}' does not match beta '${candidateVersion}'`);
  }
  if (value.targetVersion !== targetVersion) {
    fail(`Acceptance target '${value.targetVersion}' does not match requested stable '${targetVersion}'`);
  }
  if (typeof value.candidateCommit !== 'string' || !/^[a-f0-9]{40}$/.test(value.candidateCommit)) {
    fail('Acceptance candidateCommit must be a 40-character lowercase Git commit');
  }
  if (currentCommit && value.candidateCommit !== currentCommit) {
    fail(`Acceptance commit '${value.candidateCommit}' does not match HEAD '${currentCommit}'`);
  }
  validateArtifacts(value.artifacts, expectedArtifacts);
  for (const name of REQUIRED_ACCEPTANCE_CHECKS) {
    const check = value.checks?.[name];
    if (check?.passed !== true) fail(`Manual acceptance check '${name}' has not passed`);
    if (typeof check.testedBy !== 'string' || !check.testedBy.trim()) {
      fail(`Manual acceptance check '${name}' requires testedBy`);
    }
    if (!isStrictIsoUtcTimestamp(check.testedAt)) {
      fail(`Manual acceptance check '${name}' requires a real UTC ISO testedAt timestamp ` +
        '(YYYY-MM-DDTHH:mm:ss[.sss]Z)');
    }
  }
  return value;
}

function replaceExactlyOnce(source, pattern, replacement, label) {
  const matches = source.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`));
  if (!matches || matches.length !== 1) fail(`Expected exactly one ${label} in beta config.yaml`);
  return source.replace(pattern, replacement);
}

function stableConfig(betaSource, targetVersion) {
  let value = betaSource;
  value = replaceExactlyOnce(value, /^name:\s*Media Launcher Beta\s*$/m,
    'name: Media Launcher', 'beta name');
  value = replaceExactlyOnce(value, /^version:\s*"[^"]+"\s*$/m,
    `version: "${targetVersion}"`, 'version');
  value = replaceExactlyOnce(value, /^slug:\s*media_launcher_beta\s*$/m,
    'slug: media_launcher', 'beta slug');
  value = replaceExactlyOnce(value, /^description:.*$/m,
    'description: Plex or Jellyfin media browser with paired playback devices', 'description');
  value = replaceExactlyOnce(value, /^panel_title:\s*Media Launcher Beta\s*$/m,
    'panel_title: Media Launcher', 'beta panel title');
  value = replaceExactlyOnce(value, /^\s+8088\/tcp:\s*8089\s*$/m,
    '  8088/tcp: 8088', 'beta direct port');
  return value;
}

function shouldExclude(relativePath) {
  return relativePath.split(/[\\/]/).some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

function copyTree(sourceDirectory, outputDirectory, relative = '') {
  const source = relative ? path.join(sourceDirectory, relative) : sourceDirectory;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    if (shouldExclude(childRelative)) continue;
    const sourcePath = path.join(sourceDirectory, childRelative);
    const outputPath = path.join(outputDirectory, childRelative);
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink()) fail(`Promotion input cannot contain symbolic links: ${childRelative}`);
    if (entry.isDirectory()) {
      fs.mkdirSync(outputPath, { recursive: true });
      copyTree(sourceDirectory, outputDirectory, childRelative);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.copyFileSync(sourcePath, outputPath);
      fs.chmodSync(outputPath, stat.mode & 0o777);
    } else {
      fail(`Unsupported promotion input: ${childRelative}`);
    }
  }
}

function buildPromotedTree({ betaDirectory, outputDirectory, targetVersion }) {
  if (fs.existsSync(outputDirectory)) fail(`Promotion output already exists: ${outputDirectory}`);
  fs.mkdirSync(outputDirectory, { recursive: true });
  copyTree(betaDirectory, outputDirectory);

  const configPath = path.join(outputDirectory, 'config.yaml');
  fs.writeFileSync(configPath, stableConfig(fs.readFileSync(configPath, 'utf8'), targetVersion), 'utf8');

  const packagePath = path.join(outputDirectory, 'app', 'package.json');
  const packageInfo = readJson(packagePath);
  packageInfo.version = targetVersion;
  writeJson(packagePath, packageInfo);

  const lockPath = path.join(outputDirectory, 'app', 'package-lock.json');
  const lock = readJson(lockPath);
  lock.version = targetVersion;
  if (!lock.packages?.['']) fail('Beta package-lock.json has no root package record');
  lock.packages[''].version = targetVersion;
  writeJson(lockPath, lock);

  validatePromotedTree(outputDirectory, targetVersion);
  checkCatalog({
    stableDirectory: outputDirectory,
    betaDirectory,
    log: false,
  });
  return treeDigest(outputDirectory);
}

function validatePromotedTree(directory, targetVersion) {
  const config = fs.readFileSync(path.join(directory, 'config.yaml'), 'utf8');
  assert.equal(yamlScalar(config, 'name'), 'Media Launcher');
  assert.equal(yamlScalar(config, 'version'), targetVersion);
  assert.equal(yamlScalar(config, 'slug'), 'media_launcher');
  assert.equal(yamlScalar(config, 'panel_title'), 'Media Launcher');
  assert.match(config, /^\s+8088\/tcp:\s*8088\s*$/m);
  assert.doesNotMatch(config, /Media Launcher Beta|media_launcher_beta|8088\/tcp:\s*8089/);
  assert.equal(readJson(path.join(directory, 'app', 'package.json')).version, targetVersion);
  const lock = readJson(path.join(directory, 'app', 'package-lock.json'));
  assert.equal(lock.version, targetVersion);
  assert.equal(lock.packages[''].version, targetVersion);
}

function listFiles(directory, relative = '') {
  const result = [];
  const current = relative ? path.join(directory, relative) : directory;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) result.push(...listFiles(directory, child));
    else if (entry.isFile()) result.push(child.replace(/\\/g, '/'));
  }
  return result.sort();
}

function treeDigest(directory) {
  const hash = crypto.createHash('sha256');
  for (const relative of listFiles(directory)) {
    hash.update(relative);
    hash.update('\0');
    hash.update(crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, relative))).digest());
    hash.update('\0');
  }
  return hash.digest('hex');
}

function safeChild(root, name) {
  const resolvedRoot = path.resolve(root);
  const value = path.resolve(resolvedRoot, name);
  if (path.dirname(value) !== resolvedRoot) fail(`Unsafe repository path: ${value}`);
  return value;
}

function replaceStableTree({ root, generatedDirectory }) {
  const stableDirectory = safeChild(root, 'addon');
  const expectedGenerated = path.resolve(generatedDirectory);
  if (path.dirname(expectedGenerated) !== path.resolve(root)) {
    fail('Generated promotion directory must be an immediate child of the repository root');
  }
  const backup = safeChild(root, `.promotion-addon-backup-${process.pid}`);
  if (fs.existsSync(backup)) fail(`Promotion backup already exists: ${backup}`);
  fs.renameSync(stableDirectory, backup);
  try {
    fs.renameSync(expectedGenerated, stableDirectory);
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(stableDirectory) && fs.existsSync(backup)) fs.renameSync(backup, stableDirectory);
    throw error;
  }
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) fail(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

function assertCliRepositoryState(root) {
  const topLevel = path.resolve(git(root, ['rev-parse', '--show-toplevel']));
  if (topLevel !== path.resolve(root)) fail(`Run promotion from the repository root: ${topLevel}`);
  const branch = git(root, ['branch', '--show-current']);
  if (branch !== 'main') fail(`Stable promotion must run from main; current branch is '${branch || '(detached)'}'`);
  const status = git(root, ['status', '--porcelain', '--untracked-files=all']);
  if (status) fail('Stable promotion requires a completely clean worktree');
  return git(root, ['rev-parse', 'HEAD']);
}

function assertCliCandidateState(root, acceptancePath, headCommit) {
  const acceptance = readJson(acceptancePath);
  const candidateCommit = acceptance?.candidateCommit;
  if (typeof candidateCommit !== 'string' || !/^[a-f0-9]{40}$/.test(candidateCommit)) {
    fail('Acceptance candidateCommit must be a 40-character lowercase Git commit');
  }
  const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', candidateCommit, headCommit], {
    cwd: root,
    encoding: 'utf8',
  });
  if (ancestry.status !== 0) {
    fail(`Accepted beta commit '${candidateCommit}' is not an ancestor of main HEAD '${headCommit}'`);
  }
  for (const candidatePath of CANDIDATE_TREE_PATHS) {
    const acceptedTree = git(root, ['rev-parse', `${candidateCommit}:${candidatePath}`]);
    const currentTree = git(root, ['rev-parse', `${headCommit}:${candidatePath}`]);
    if (acceptedTree !== currentTree) {
      fail(`${candidatePath} changed after manual acceptance; repeat the acceptance checks ` +
        'and publish new candidate artifacts');
    }
  }
}

function preparePromotion({ root, targetVersion, acceptancePath, currentCommit }) {
  const betaDirectory = safeChild(root, 'addon-beta');
  const candidateVersion = betaVersion(betaDirectory);
  validateVersionPair(candidateVersion, targetVersion);
  validateAcceptance(readJson(acceptancePath), {
    candidateVersion,
    targetVersion,
    currentCommit,
    expectedArtifacts: expectedAcceptanceArtifacts(root),
  });
  return { betaDirectory, candidateVersion };
}

function promote({ root, targetVersion, acceptancePath, currentCommit, write = false }) {
  const { betaDirectory, candidateVersion } = preparePromotion({
    root, targetVersion, acceptancePath, currentCommit,
  });
  const generatedDirectory = write
    ? safeChild(root, `.promotion-addon-${process.pid}`)
    : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'media-launcher-promotion-')), 'addon');
  const temporaryRoot = write ? null : path.dirname(generatedDirectory);
  try {
    const digest = buildPromotedTree({ betaDirectory, outputDirectory: generatedDirectory, targetVersion });
    if (write) replaceStableTree({ root, generatedDirectory });
    return { candidateVersion, targetVersion, digest, wrote: write };
  } finally {
    if (fs.existsSync(generatedDirectory)) fs.rmSync(generatedDirectory, { recursive: true, force: true });
    if (temporaryRoot && fs.existsSync(temporaryRoot)) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const root = path.resolve(__dirname, '..');
  const headCommit = assertCliRepositoryState(root);
  const acceptancePath = path.resolve(options.acceptance);
  assertCliCandidateState(root, acceptancePath, headCommit);
  const result = promote({
    root,
    targetVersion: options.version,
    acceptancePath,
    currentCommit: '',
    write: options.write,
  });
  console.log(`${options.write ? 'Promoted' : 'Verified promotion of'} ${result.candidateVersion} ` +
    `to ${result.targetVersion}; deterministic tree SHA256 ${result.digest}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Promotion refused: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  betaVersion,
  assertCliCandidateState,
  buildPromotedTree,
  expectedAcceptanceArtifacts,
  isStrictIsoUtcTimestamp,
  parseArguments,
  preparePromotion,
  promote,
  stableConfig,
  treeDigest,
  validateAcceptance,
  validatePromotedTree,
  validateVersionPair,
};
