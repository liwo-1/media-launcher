'use strict';

const { getClientId, setStoredToken } = require('./token-store');
const { readSettings } = require('./settings-store');
const { normalizeServerUrl } = require('./server-url');

const REQUEST_TIMEOUT_MS = 15000;
const MAX_PENDING_PINS = 64;
const pendingPins = new Map();
let pinEpoch = 0;

function cleanEnvironmentValue(name) {
  return typeof process.env[name] === 'string' ? process.env[name].trim() : '';
}

function headers() {
  return {
    Accept: 'application/json',
    'X-Plex-Product': 'Media Launcher',
    'X-Plex-Client-Identifier': getClientId(),
  };
}

function rejectRedirect(response, action) {
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Plex returned an unexpected redirect while ${action}`);
  }
}

// Plex's official device-linking flow: request a short PIN, have the user enter it at
// plex.tv/link, then poll until Plex attaches an account token to it.
async function requestPin() {
  const serverUrl = normalizeServerUrl(cleanEnvironmentValue('PLEX_URL') || readSettings().plexUrl, {
    required: true,
    field: 'Plex server URL',
  });
  const epoch = pinEpoch;
  const response = await fetch('https://plex.tv/api/v2/pins', {
    method: 'POST',
    headers: headers(),
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  rejectRedirect(response, 'requesting a PIN');
  if (!response.ok) throw new Error(`Failed to request a Plex PIN (${response.status})`);
  const data = await response.json();
  const id = String(data.id ?? '');
  const code = typeof data.code === 'string' ? data.code : '';
  if (!/^\d{1,20}$/.test(id) || !code || code.length > 32) {
    throw new Error('Plex returned an invalid PIN response');
  }
  const reportedExpiry = Number(data.expiresIn);
  const expiresIn = Number.isFinite(reportedExpiry) && reportedExpiry > 0
    ? Math.min(1800, Math.max(30, Math.floor(reportedExpiry)))
    : 600;
  if (epoch !== pinEpoch) {
    const error = new Error('Plex linking was cancelled. Request a new code.');
    error.status = 409;
    throw error;
  }
  const now = Date.now();
  for (const [pendingId, pending] of pendingPins) {
    if (pending.expiresAt <= now) pendingPins.delete(pendingId);
  }
  if (pendingPins.size >= MAX_PENDING_PINS) {
    pendingPins.delete(pendingPins.keys().next().value);
  }
  // The browser receives only the opaque PIN id/code. The backend retains the exact server scope
  // that was current when this linking attempt began, so another tab cannot redirect its token.
  pendingPins.set(id, { serverUrl, expiresAt: now + expiresIn * 1000 });
  return { id, code, expiresIn };
}

async function checkPin(id) {
  const normalizedId = String(id ?? '');
  if (!/^\d{1,20}$/.test(normalizedId)) throw new Error('Invalid Plex PIN id');
  const pending = pendingPins.get(normalizedId);
  if (!pending) {
    const error = new Error('This Plex link code is unknown. Request a new code.');
    error.status = 400;
    throw error;
  }
  if (pending.expiresAt <= Date.now()) {
    pendingPins.delete(normalizedId);
    const error = new Error('This Plex link code expired. Request a new code.');
    error.status = 410;
    throw error;
  }
  const response = await fetch(`https://plex.tv/api/v2/pins/${encodeURIComponent(normalizedId)}`, {
    headers: headers(),
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  rejectRedirect(response, 'checking the PIN');
  if (!response.ok) throw new Error(`Failed to check the Plex PIN (${response.status})`);
  const data = await response.json();
  if (!data.authToken) return { linked: false };
  if (typeof data.authToken !== 'string' || data.authToken.length > 4096) {
    throw new Error('Plex returned an invalid account token');
  }
  if (pendingPins.get(normalizedId) !== pending) {
    const error = new Error('Plex linking was cancelled. Request a new code.');
    error.status = 409;
    throw error;
  }
  const currentServerUrl = normalizeServerUrl(
    cleanEnvironmentValue('PLEX_URL') || readSettings().plexUrl,
    {
      required: true,
      field: 'Plex server URL',
    }
  );
  if (currentServerUrl !== pending.serverUrl) {
    pendingPins.delete(normalizedId);
    const error = new Error('The Plex server URL changed while linking. Request a new code.');
    error.status = 409;
    throw error;
  }
  setStoredToken(data.authToken, pending.serverUrl);
  pendingPins.delete(normalizedId);
  return { linked: true };
}

function unlink() {
  if (cleanEnvironmentValue('PLEX_TOKEN')) {
    const error = new Error('Plex authentication is managed by environment variables.');
    error.status = 409;
    throw error;
  }
  pinEpoch += 1;
  setStoredToken(null);
  pendingPins.clear();
}

module.exports = {
  requestPin,
  checkPin,
  unlink,
  _test: { MAX_PENDING_PINS, REQUEST_TIMEOUT_MS, getPinEpoch: () => pinEpoch, pendingPins },
};
