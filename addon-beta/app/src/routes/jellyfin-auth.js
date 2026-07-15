const crypto = require('crypto');
const express = require('express');
const { authenticateCandidate } = require('../jellyfin-auth');
const { clearCredentials, saveCredentials } = require('../jellyfin-auth-store');
const { cancelProviderSessions } = require('../playback-monitor');
const { normalizeServerUrl } = require('../server-url');
const { writeSettings } = require('../settings-store');

const router = express.Router();
const attempts = new Map();
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_SOURCES = 512;
const LINK_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING_LINKS = 64;
const pendingLinks = new Map();
let linkEpoch = 0;

function discardPendingLink(id, expected = null) {
  const pending = pendingLinks.get(id);
  if (!pending || (expected && pending !== expected)) return false;
  pendingLinks.delete(id);
  if (pending.expiryTimer) clearTimeout(pending.expiryTimer);
  if (pending.candidate?.credentials) pending.candidate.credentials.accessToken = '';
  return true;
}

function allowAuthentication(source, now = Date.now()) {
  for (const [key, entry] of attempts) {
    if (now - entry.startedAt >= WINDOW_MS) attempts.delete(key);
  }
  const key = String(source || 'unknown');
  const current = attempts.get(key);
  if (!current) {
    if (attempts.size >= MAX_SOURCES) attempts.delete(attempts.keys().next().value);
    attempts.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= MAX_ATTEMPTS;
}

function storePendingLink(candidate, epoch, now = Date.now()) {
  for (const [id, pending] of pendingLinks) {
    if (pending.expiresAt <= now || pending.epoch !== linkEpoch) discardPendingLink(id, pending);
  }
  if (pendingLinks.size >= MAX_PENDING_LINKS) {
    discardPendingLink(pendingLinks.keys().next().value);
  }
  const id = crypto.randomUUID();
  const pending = {
    candidate,
    epoch,
    expiresAt: now + LINK_TTL_MS,
    expiryTimer: null,
  };
  pending.expiryTimer = setTimeout(() => discardPendingLink(id, pending), LINK_TTL_MS);
  pending.expiryTimer.unref?.();
  pendingLinks.set(id, pending);
  return id;
}

router.post('/login', async (req, res) => {
  if (!allowAuthentication(req.ip)) {
    res.set('Retry-After', String(Math.ceil(WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Too many Jellyfin sign-in attempts. Try again later.' });
  }
  let serverUrl;
  try {
    serverUrl = normalizeServerUrl(req.body?.serverUrl || '', {
      required: true,
      field: 'Jellyfin server URL',
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  try {
    const epoch = linkEpoch;
    const candidate = await authenticateCandidate({ ...req.body, serverUrl });
    if (epoch !== linkEpoch) {
      candidate.credentials.accessToken = '';
      return res.status(409).json({ error: 'Jellyfin linking was cancelled. Sign in again.' });
    }
    const linkId = storePendingLink(candidate, epoch);
    return res.json({ ...candidate.publicResult, linkId });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
});

router.post('/login/commit', (req, res) => {
  const linkId = typeof req.body?.linkId === 'string' ? req.body.linkId : '';
  if (!/^[0-9a-f-]{36}$/i.test(linkId)) {
    return res.status(400).json({ error: 'A valid Jellyfin link id is required.' });
  }
  const pending = pendingLinks.get(linkId);
  if (!pending || pending.epoch !== linkEpoch) {
    return res.status(409).json({ error: 'This Jellyfin sign-in is no longer pending. Sign in again.' });
  }
  if (pending.expiresAt <= Date.now()) {
    discardPendingLink(linkId, pending);
    return res.status(410).json({ error: 'This Jellyfin sign-in expired. Sign in again.' });
  }
  try {
    // Make the server selection visible first. If credential persistence unexpectedly fails, the
    // Settings screen remains recoverably unlinked instead of leaving a hidden stored token.
    writeSettings({
      mediaProvider: 'jellyfin',
      jellyfinUrl: pending.candidate.credentials.serverUrl,
    });
    const stored = saveCredentials(pending.candidate.credentials);
    discardPendingLink(linkId, pending);
    return res.json({
      linked: true,
      accountDisplayName: stored.username,
      serverName: stored.serverName,
      isAdministrator: stored.isAdministrator,
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/unlink', (_req, res) => {
  try {
    linkEpoch += 1;
    for (const id of [...pendingLinks.keys()]) discardPendingLink(id);
    clearCredentials();
    cancelProviderSessions('jellyfin');
    return res.json({ linked: false });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
module.exports._test = {
  LINK_TTL_MS,
  allowAuthentication,
  attempts,
  getLinkEpoch: () => linkEpoch,
  discardPendingLink,
  pendingLinks,
  storePendingLink,
};
