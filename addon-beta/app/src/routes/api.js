const express = require('express');
const plex = require('../plex');
const { validatePlexImagePath } = require('../media-image-ref');
const { assertBoundedImage, pipeImageBody, safeImageContentType } = require('../image-stream');
const { playItem, PlayError } = require('../play');
const { getPlaybackTargets } = require('../playback-targets');
const { activeProviderKind } = require('../provider-manager');
const { AgentRequestError, controlSession } = require('../agent-client');
const { finalizeTargetSession, listPlaybackSessions } = require('../playback-monitor');

const router = express.Router();
const CONTROL_ACTIONS = new Set(['pause', 'resume', 'seek', 'stop']);
const MAX_SEEK_POSITION_MS = 7 * 24 * 60 * 60 * 1000;

function playbackControlRequest(req) {
  const sessionId = req.params.sessionId;
  if (typeof sessionId !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(sessionId)) {
    throw new AgentRequestError('sessionId must contain only letters, numbers, underscores, or hyphens.', 400);
  }

  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AgentRequestError('Request body must be a JSON object.', 400);
  }
  const unexpected = Object.keys(body).filter(
    (key) => !['targetId', 'action', 'positionMs'].includes(key)
  );
  if (unexpected.length) {
    throw new AgentRequestError(`Unexpected playback control field: ${unexpected[0]}.`, 400);
  }
  if (typeof body.targetId !== 'string' || !/^target-[a-f0-9]{24}$/.test(body.targetId)) {
    throw new AgentRequestError('targetId must be a valid playback target ID.', 400);
  }
  if (typeof body.action !== 'string' || !CONTROL_ACTIONS.has(body.action)) {
    throw new AgentRequestError('action must be pause, resume, seek, or stop.', 400);
  }
  if (body.action === 'seek') {
    if (
      !Number.isSafeInteger(body.positionMs) ||
      body.positionMs < 0 ||
      body.positionMs > MAX_SEEK_POSITION_MS
    ) {
      throw new AgentRequestError('positionMs must be an integer between 0 and seven days for seek.', 400);
    }
  } else if (body.positionMs !== undefined) {
    throw new AgentRequestError('positionMs is only valid for seek.', 400);
  }
  return {
    targetId: body.targetId,
    sessionId,
    control: body.action === 'seek'
      ? { action: body.action, positionMs: body.positionMs }
      : { action: body.action },
  };
}

function requireActivePlex(_req, res, next) {
  if (activeProviderKind() !== 'plex') {
    return res.status(409).json({
      error: 'This legacy Plex endpoint is unavailable while Jellyfin is active. Use /api/media instead.',
    });
  }
  return next();
}

function redactLegacyPlex(value) {
  if (Array.isArray(value)) return value.map(redactLegacyPlex);
  if (!value || typeof value !== 'object') return value;
  const redacted = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === 'file' || normalizedKey === 'path') continue;
    redacted[key] = redactLegacyPlex(entry);
  }
  return redacted;
}

router.get('/playback-targets', async (_req, res) => {
  try {
    res.json(await getPlaybackTargets());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/libraries', requireActivePlex, async (_req, res) => {
  try {
    const sections = await plex.getSections();
    res.json({ Items: redactLegacyPlex(sections) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/items', requireActivePlex, async (req, res) => {
  const { parentId } = req.query;
  if (!parentId) {
    return res.status(400).json({ error: 'parentId query param is required' });
  }
  try {
    const items = await plex.getItems(parentId);
    res.json({ Items: redactLegacyPlex(items) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/libraries/:key/recentlyAdded', requireActivePlex, async (req, res) => {
  try {
    const items = await plex.getRecentlyAdded(req.params.key);
    res.json({ Items: redactLegacyPlex(items) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/items/:id', requireActivePlex, async (req, res) => {
  try {
    const item = await plex.getItemFull(req.params.id);
    res.json(redactLegacyPlex(item));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/items/:id/related', requireActivePlex, async (req, res) => {
  try {
    const items = await plex.getRelated(req.params.id);
    res.json({ Items: redactLegacyPlex(items) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/shows/:id/seasons', requireActivePlex, async (req, res) => {
  try {
    const seasons = await plex.getSeasons(req.params.id);
    res.json({ Items: redactLegacyPlex(seasons) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/shows/:id/seasons/:seasonId/episodes', requireActivePlex, async (req, res) => {
  try {
    const episodes = await plex.getEpisodes(req.params.seasonId);
    res.json({ Items: redactLegacyPlex(episodes) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/libraries/:key/scan', requireActivePlex, async (req, res) => {
  try {
    await plex.scanLibrary(req.params.key);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/ondeck', requireActivePlex, async (_req, res) => {
  try {
    const items = await plex.getOnDeck();
    res.json({ Items: redactLegacyPlex(items) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/items/:id/watched', requireActivePlex, async (req, res) => {
  try {
    await plex.markWatched(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/items/:id/unwatched', requireActivePlex, async (req, res) => {
  try {
    await plex.markUnwatched(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/image', requireActivePlex, async (req, res) => {
  let relativePath;
  try {
    relativePath = validatePlexImagePath(req.query.path);
  } catch {
    return res.status(400).json({ error: 'query param "path" must be a Plex /library/... path' });
  }
  try {
    const imageResponse = await plex.getImage(relativePath);
    const contentType = safeImageContentType(imageResponse);
    if (!imageResponse.body || !contentType) {
      return res.status(502).json({ error: 'Plex returned invalid artwork' });
    }
    assertBoundedImage(imageResponse);
    res.set('Content-Type', contentType);
    res.set('X-Content-Type-Options', 'nosniff');
    for (const header of ['content-length', 'cache-control', 'etag', 'last-modified']) {
      const value = imageResponse.headers.get(header);
      if (value && value.length <= 1024 && /^[\t\x20-\x7e]*$/.test(value)) {
        res.set(header, value);
      }
    }
    pipeImageBody(imageResponse, res);
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: err.message });
    else res.destroy(err);
  }
});

router.post('/play/:id', async (req, res) => {
  try {
    const targetId = req.body?.targetId;
    if (targetId !== undefined && typeof targetId !== 'string') {
      return res.status(400).json({ error: 'targetId must be a string' });
    }
    const result = await playItem(req.params.id, targetId || '');
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = err instanceof PlayError ? err.status : 502;
    console.error(`play request failed: ${err.message}`);
    res.status(status).json({ error: err.message });
  }
});

router.get('/playback-sessions', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ sessions: listPlaybackSessions() });
});

router.post('/playback-sessions/:sessionId/control', async (req, res) => {
  try {
    const { targetId, sessionId, control } = playbackControlRequest(req);
    const result = await controlSession(targetId, sessionId, control);
    if (control.action === 'stop') {
      await finalizeTargetSession(targetId, sessionId, { endReason: 'stopped-by-request' });
    }
    res.json(result);
  } catch (err) {
    const status = err instanceof AgentRequestError ? err.status : 502;
    if (!(err instanceof AgentRequestError)) {
      console.error(`playback control request failed: ${err.message}`);
    }
    res.status(status).json({
      error: err instanceof AgentRequestError ? err.message : 'The playback command could not be completed.',
    });
  }
});

module.exports = router;
module.exports._test = { playbackControlRequest, redactLegacyPlex };
