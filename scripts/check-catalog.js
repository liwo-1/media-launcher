const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadApp(directory) {
  for (const required of ['config.yaml', 'Dockerfile', 'run.sh', 'app/package.json', 'app/package-lock.json']) {
    assert.ok(fs.existsSync(path.join(directory, required)), `${directory}/${required} is missing`);
  }

  const config = fs.readFileSync(path.join(directory, 'config.yaml'), 'utf8');
  const scalar = (key) => {
    const match = config.match(new RegExp(`^${key}:\\s*["']?([^"'\\r\\n]+)["']?\\s*$`, 'm'));
    assert.ok(match, `${directory}/config.yaml is missing ${key}`);
    return match[1].trim();
  };
  const port = config.match(/^\s+8088\/tcp:\s*(\d+)\s*$/m);
  assert.ok(port, `${directory}/config.yaml must expose container port 8088`);

  return {
    name: scalar('name'),
    version: scalar('version'),
    slug: scalar('slug'),
    hostPort: Number(port[1]),
  };
}

const stable = loadApp('addon');
const beta = loadApp('addon-beta');

assert.equal(stable.name, 'Media Launcher');
assert.equal(stable.slug, 'media_launcher');
assert.equal(stable.hostPort, 8088);

assert.equal(beta.name, 'Media Launcher Beta');
assert.equal(beta.slug, 'media_launcher_beta');
assert.equal(beta.hostPort, 8089);

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
assert.match(stable.version, versionPattern);
assert.match(beta.version, versionPattern);

assert.notEqual(stable.slug, beta.slug);
assert.notEqual(stable.hostPort, beta.hostPort);

console.log(`Catalogue checked: ${stable.name} ${stable.version}, ${beta.name} ${beta.version}`);
