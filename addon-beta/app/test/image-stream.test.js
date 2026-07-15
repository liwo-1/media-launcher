'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  ImageStreamError,
  assertBoundedImage,
  pipeImageBody,
  safeImageContentType,
} = require('../src/image-stream');

test('rejects declared oversized artwork before response headers are committed', () => {
  const response = new Response(new Uint8Array(), {
    headers: { 'Content-Length': '100' },
  });
  assert.throws(
    () => assertBoundedImage(response, 10),
    (error) => error instanceof ImageStreamError && error.status === 502
  );
});

test('allows raster artwork types but rejects active SVG documents', () => {
  assert.equal(safeImageContentType(new Response('', {
    headers: { 'Content-Type': 'IMAGE/WEBP; charset=binary' },
  })), 'image/webp');
  assert.equal(safeImageContentType(new Response('', {
    headers: { 'Content-Type': 'image/svg+xml' },
  })), '');
});

test('aborts an artwork body that exceeds its streaming byte limit', async () => {
  const response = new Response(new Uint8Array([1, 2, 3, 4]));
  const destination = new PassThrough();
  let received = 0;
  destination.on('data', (chunk) => { received += chunk.length; });
  destination.resume();
  const failed = once(destination, 'error');

  pipeImageBody(response, destination, { maxBytes: 2, timeoutMs: 1000 });

  const [error] = await failed;
  assert.match(error.message, /oversized artwork/);
  assert.equal(received, 0, 'an oversized chunk must not reach the client');
});

test('aborts a stalled artwork body after its bounded streaming timeout', async () => {
  const response = {
    headers: new Headers(),
    body: new ReadableStream({ start() {} }),
  };
  const destination = new PassThrough();
  destination.resume();
  const failed = once(destination, 'error');

  pipeImageBody(response, destination, { maxBytes: 10, timeoutMs: 10 });

  const [error] = await failed;
  assert.match(error.message, /timed out/);
});
