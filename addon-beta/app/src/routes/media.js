'use strict';

const express = require('express');
const { MediaProviderError } = require('../media-model');
const { MAX_IMAGE_REF_LENGTH } = require('../media-image-ref');
const { assertBoundedImage, pipeImageBody, safeImageContentType } = require('../image-stream');
const { createActiveProvider } = require('../provider-manager');

const MAX_ID_LENGTH = 256;
const MAX_QUERY_LENGTH = 256;
const SAFE_IMAGE_HEADERS = ['content-length', 'cache-control', 'etag', 'last-modified'];

function providerStatus(error) {
  if (error instanceof MediaProviderError) return error.status;
  if (error instanceof TypeError) return 400;
  return Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 502;
}

function sendError(res, error) {
  const status = providerStatus(error);
  if (!(error instanceof MediaProviderError) && !(error instanceof TypeError)) {
    console.error(`media provider request failed: ${error?.message || error}`);
  }
  const message = status >= 500 && !(error instanceof MediaProviderError)
    ? 'The media server request failed.'
    : error.message;
  return res.status(status).json({ error: message || 'The media server request failed.' });
}

function requireId(value, label = 'id') {
  if (typeof value !== 'string' || !value || value.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new MediaProviderError(`${label} is invalid.`, {
      status: 400,
      code: 'invalid_id',
    });
  }
  return value;
}

function requireArtworkRef(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_IMAGE_REF_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new MediaProviderError('Artwork reference is invalid.', {
      status: 400,
      code: 'invalid_artwork_ref',
    });
  }
  return value;
}

function safeUpstreamHeader(value) {
  return typeof value === 'string' && value.length <= 1024 && /^[\t\x20-\x7e]*$/.test(value)
    ? value
    : '';
}

function createMediaRouter({ providerFactory = createActiveProvider } = {}) {
  const router = express.Router();

  const itemsRoute = (operation) => async (req, res) => {
    try {
      const items = await operation(providerFactory(), req);
      return res.json({ items });
    } catch (error) {
      return sendError(res, error);
    }
  };

  router.get('/libraries', itemsRoute((provider) => provider.listLibraries()));

  router.get('/libraries/:id/items', itemsRoute((provider, req) => (
    provider.listItems(requireId(req.params.id, 'Library id'))
  )));

  router.get('/libraries/:id/recently-added', itemsRoute((provider, req) => (
    provider.listRecentlyAdded(requireId(req.params.id, 'Library id'))
  )));

  router.get('/continue-watching', itemsRoute((provider) => provider.listContinueWatching()));

  router.get('/search', itemsRoute((provider, req) => {
    if (typeof req.query.q !== 'string') {
      throw new MediaProviderError('Search query is required.', {
        status: 400,
        code: 'invalid_search_query',
      });
    }
    const query = req.query.q.trim();
    if (!query || query.length > MAX_QUERY_LENGTH) {
      throw new MediaProviderError('Search query must contain 1 to 256 characters.', {
        status: 400,
        code: 'invalid_search_query',
      });
    }
    return provider.search(query);
  }));

  router.get('/items/:id', async (req, res) => {
    try {
      return res.json(await providerFactory().getItem(requireId(req.params.id, 'Media item id')));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/items/:id/related', itemsRoute((provider, req) => (
    provider.getRelated(requireId(req.params.id, 'Media item id'))
  )));

  router.get('/series/:id/seasons', itemsRoute((provider, req) => (
    provider.getSeasons(requireId(req.params.id, 'Series id'))
  )));

  router.get('/series/:seriesId/seasons/:seasonId/episodes', itemsRoute((provider, req) => (
    provider.getEpisodes(
      requireId(req.params.seriesId, 'Series id'),
      requireId(req.params.seasonId, 'Season id')
    )
  )));

  router.post('/items/:id/watched', async (req, res) => {
    try {
      if (typeof req.body?.watched !== 'boolean') {
        throw new MediaProviderError('watched must be a boolean.', {
          status: 400,
          code: 'invalid_watched_state',
        });
      }
      await providerFactory().setWatched(
        requireId(req.params.id, 'Media item id'),
        req.body.watched
      );
      return res.json({ ok: true });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/libraries/:id/scan', async (req, res) => {
    try {
      await providerFactory().scanLibrary(requireId(req.params.id, 'Library id'));
      return res.json({ ok: true });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/images/:ref', async (req, res) => {
    try {
      const ref = requireArtworkRef(req.params.ref);
      const response = await providerFactory().openArtwork(ref);
      const contentType = safeImageContentType(response);
      if (!response?.body || !contentType) {
        throw new MediaProviderError('The media server returned invalid artwork.', {
          status: 502,
          code: 'invalid_artwork_response',
        });
      }
      assertBoundedImage(response);

      res.set('Content-Type', contentType);
      res.set('X-Content-Type-Options', 'nosniff');
      for (const header of SAFE_IMAGE_HEADERS) {
        const value = safeUpstreamHeader(response.headers.get(header));
        if (value) res.set(header, value);
      }
      pipeImageBody(response, res);
      return undefined;
    } catch (error) {
      if (res.headersSent) res.destroy(error);
      else sendError(res, error);
      return undefined;
    }
  });

  return router;
}

module.exports = {
  createMediaRouter,
  requireArtworkRef,
  requireId,
  sendError,
};
