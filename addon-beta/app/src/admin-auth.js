const crypto = require('crypto');
const { readSettings } = require('./settings-store');

const KEY_LENGTH = 32;
const FAILURE_WINDOW_MS = 60 * 1000;
const MAX_FAILURES = 8;
const MAX_SOURCES = 512;
const failures = new Map();

function hashPin(pin) {
  const normalized = String(pin);
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(normalized, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPin(pin, encoded) {
  try {
    const [algorithm, saltHex, hashHex] = String(encoded).split('$');
    if (algorithm !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    if (expected.length !== KEY_LENGTH) return false;
    const actual = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function failureState(source, now = Date.now()) {
  for (const [key, entry] of failures) {
    if (now - entry.startedAt >= FAILURE_WINDOW_MS) failures.delete(key);
  }
  const key = String(source || 'unknown');
  const entry = failures.get(key);
  return { key, entry, blocked: Boolean(entry && entry.count >= MAX_FAILURES) };
}

function recordFailure(key, now = Date.now()) {
  const current = failures.get(key);
  if (!current || now - current.startedAt >= FAILURE_WINDOW_MS) {
    if (failures.size >= MAX_SOURCES) failures.delete(failures.keys().next().value);
    failures.set(key, { startedAt: now, count: 1 });
    return;
  }
  current.count += 1;
}

function requireAdminPin(req, res, next) {
  let adminPinHash;
  try {
    ({ adminPinHash } = readSettings());
  } catch (error) {
    console.error(`Could not read protected settings: ${error.message}`);
    return res.status(503).json({
      error: 'Settings storage is unavailable. Repair or restore /data/settings.json and restart the add-on.',
    });
  }
  if (!adminPinHash) return next();

  const supplied = req.headers['x-admin-pin'];
  if (typeof supplied !== 'string') {
    return res.status(401).json({ error: 'Missing or incorrect admin PIN', adminPinRequired: true });
  }
  const state = failureState(req.ip || req.socket?.remoteAddress);
  if (state.blocked) {
    const retryAfter = Math.max(
      1,
      Math.ceil((state.entry.startedAt + FAILURE_WINDOW_MS - Date.now()) / 1000)
    );
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: 'Too many incorrect admin PIN attempts. Try again shortly.',
      adminPinRequired: true,
    });
  }
  if (!verifyPin(supplied, adminPinHash)) {
    recordFailure(state.key);
    return res.status(401).json({ error: 'Missing or incorrect admin PIN', adminPinRequired: true });
  }
  failures.delete(state.key);
  next();
}

module.exports = {
  hashPin,
  verifyPin,
  requireAdminPin,
  _test: { FAILURE_WINDOW_MS, MAX_FAILURES, failureState, failures, recordFailure },
};
