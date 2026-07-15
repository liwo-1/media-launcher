'use strict';

const { TextDecoder } = require('util');

const MAX_IMAGE_REF_LENGTH = 2048;
const MAX_IMAGE_PATH_BYTES = 1536;
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const PAYLOAD_PATTERN = /^[A-Za-z0-9_-]+$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function assertProvider(provider) {
  if (typeof provider !== 'string' || !PROVIDER_PATTERN.test(provider)) {
    throw new TypeError('Invalid image provider');
  }
}

function assertBoundedPath(path) {
  if (typeof path !== 'string' || !path) throw new TypeError('Invalid image path');
  const bytes = Buffer.byteLength(path, 'utf8');
  if (bytes > MAX_IMAGE_PATH_BYTES) throw new TypeError('Image path is too long');
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw new TypeError('Image path contains control characters');
  }
}

function encodeImageRef(provider, path) {
  assertProvider(provider);
  assertBoundedPath(path);
  const payload = Buffer.from(path, 'utf8').toString('base64url');
  const ref = `${provider}:${payload}`;
  if (ref.length > MAX_IMAGE_REF_LENGTH) throw new TypeError('Image reference is too long');
  return ref;
}

function decodeImageRef(ref, expectedProvider = '') {
  if (typeof ref !== 'string' || !ref || ref.length > MAX_IMAGE_REF_LENGTH) {
    throw new TypeError('Invalid image reference');
  }
  const separator = ref.indexOf(':');
  if (separator <= 0 || separator !== ref.lastIndexOf(':')) {
    throw new TypeError('Invalid image reference');
  }

  const provider = ref.slice(0, separator);
  const payload = ref.slice(separator + 1);
  assertProvider(provider);
  if (expectedProvider && provider !== expectedProvider) {
    throw new TypeError('Image reference belongs to a different provider');
  }
  if (!payload || !PAYLOAD_PATTERN.test(payload) || payload.length % 4 === 1) {
    throw new TypeError('Invalid image reference encoding');
  }

  const bytes = Buffer.from(payload, 'base64url');
  if (!bytes.length || bytes.length > MAX_IMAGE_PATH_BYTES || bytes.toString('base64url') !== payload) {
    throw new TypeError('Invalid image reference encoding');
  }

  let path;
  try {
    path = utf8Decoder.decode(bytes);
  } catch {
    throw new TypeError('Invalid image reference encoding');
  }
  assertBoundedPath(path);
  return { provider, path };
}

function validatePlexImagePath(path) {
  assertBoundedPath(path);
  if (!path.startsWith('/library/') || path.includes('\\') || path.includes('#')) {
    throw new TypeError('Plex artwork must use a /library/ path');
  }

  let parsed;
  let decodedPath;
  try {
    parsed = new URL(path, 'http://plex.invalid');
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    throw new TypeError('Invalid Plex artwork path');
  }
  if (parsed.origin !== 'http://plex.invalid' || !decodedPath.startsWith('/library/')) {
    throw new TypeError('Plex artwork must use a /library/ path');
  }
  if (decodedPath.includes('\\') || /[\u0000-\u001f\u007f]/.test(decodedPath)) {
    throw new TypeError('Invalid Plex artwork path');
  }
  if (decodedPath.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new TypeError('Invalid Plex artwork path');
  }
  for (const key of parsed.searchParams.keys()) {
    if (key.toLowerCase() === 'x-plex-token') {
      throw new TypeError('Plex artwork references cannot contain credentials');
    }
  }
  return path;
}

function encodePlexImageRef(path) {
  return encodeImageRef('plex', validatePlexImagePath(path));
}

function decodePlexImageRef(ref) {
  const decoded = decodeImageRef(ref, 'plex');
  return validatePlexImagePath(decoded.path);
}

module.exports = {
  MAX_IMAGE_REF_LENGTH,
  MAX_IMAGE_PATH_BYTES,
  encodeImageRef,
  decodeImageRef,
  validatePlexImagePath,
  encodePlexImageRef,
  decodePlexImageRef,
};
