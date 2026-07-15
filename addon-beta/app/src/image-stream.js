'use strict';

const { Readable, Transform, pipeline } = require('stream');

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_BODY_TIMEOUT_MS = 30000;
const SAFE_IMAGE_CONTENT_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/tiff',
  'image/vnd.microsoft.icon',
  'image/webp',
  'image/x-icon',
]);

class ImageStreamError extends Error {
  constructor(message) {
    super(message);
    this.status = 502;
  }
}

function assertBoundedImage(response, maxBytes = MAX_IMAGE_BYTES) {
  const value = response?.headers?.get('content-length');
  if (value === null || value === undefined || value === '') return;
  if (!/^\d+$/.test(value) || Number(value) > maxBytes) {
    throw new ImageStreamError('The media server returned oversized artwork.');
  }
}

function safeImageContentType(response) {
  const contentType = (response?.headers?.get('content-type') || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  return SAFE_IMAGE_CONTENT_TYPES.has(contentType) ? contentType : '';
}

function pipeImageBody(response, res, {
  maxBytes = MAX_IMAGE_BYTES,
  timeoutMs = IMAGE_BODY_TIMEOUT_MS,
} = {}) {
  assertBoundedImage(response, maxBytes);
  const stream = Readable.fromWeb(response.body);
  let received = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) {
        callback(new ImageStreamError('The media server returned oversized artwork.'));
        return;
      }
      callback(null, chunk);
    },
  });
  const timeout = setTimeout(() => {
    stream.destroy(new ImageStreamError('The artwork response timed out.'));
  }, timeoutMs);

  pipeline(stream, limiter, res, (error) => {
    clearTimeout(timeout);
    if (error && !res.destroyed) res.destroy(error);
  });
  return stream;
}

module.exports = {
  IMAGE_BODY_TIMEOUT_MS,
  MAX_IMAGE_BYTES,
  ImageStreamError,
  assertBoundedImage,
  pipeImageBody,
  safeImageContentType,
};
