const crypto = require('crypto');
const { readSettings } = require('./settings-store');

const KEY_LENGTH = 32;

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

function requireAdminPin(req, res, next) {
  const { adminPinHash } = readSettings();
  if (!adminPinHash) return next();

  const supplied = req.headers['x-admin-pin'];
  if (typeof supplied !== 'string' || !verifyPin(supplied, adminPinHash)) {
    return res.status(401).json({ error: 'Missing or incorrect admin PIN', adminPinRequired: true });
  }
  next();
}

module.exports = { hashPin, verifyPin, requireAdminPin };
