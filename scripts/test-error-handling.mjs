/**
 * Error-handling test suite.
 *
 *   node --test backend/scripts/test-error-handling.mjs
 *
 * Part 1 exercises `normalize()` directly (no server needed): every failure
 * class the platform can produce is mapped to the right status + code.
 * Part 2 talks to a running backend (default http://localhost:8000) and asserts
 * the real HTTP status, the JSON envelope and the correlation id.
 *
 * No order, payment or admin write happens here: only rejected requests are
 * sent, so no production data is created.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalize } = require('../src/middleware/errorHandler.js');
const { ApiError } = require('../src/lib/apiError.js');

const BASE = process.env.API_BASE || 'http://localhost:8000';
const SAFE_500 = "We're having trouble processing your request. Please try again shortly.";

/* ------------------------------------------------------------------ *
 * Part 1 - mapping
 * ------------------------------------------------------------------ */

test('ApiError keeps its safe message and status', () => {
  const out = normalize(new ApiError({ status: 409, code: 'CONFLICT', message: 'Already done.' }));
  assert.equal(out.status, 409);
  assert.equal(out.code, 'CONFLICT');
  assert.equal(out.message, 'Already done.');
});

test('ApiError with expose:false never leaks its message', () => {
  const out = normalize(new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'E11000 dup key', expose: false }));
  assert.equal(out.status, 500);
  assert.equal(out.message, SAFE_500);
});

test('image validation codes map to 415 / 413 / 422 / 400', () => {
  const make = (code, message) => {
    const e = new Error(message);
    e.name = 'ImageValidationError';
    e.code = code;
    e.statusCode = 400;
    return e;
  };

  assert.equal(normalize(make('UNSUPPORTED_FORMAT', 'Unsupported image format: pdf')).status, 415);
  assert.equal(normalize(make('FILE_TOO_LARGE', 'File size 8.4MB exceeds the 8MB upload limit')).status, 413);
  assert.equal(normalize(make('IMAGE_TOO_LARGE', 'too big')).status, 413);
  assert.equal(normalize(make('INVALID_IMAGE', 'Invalid or unreadable image file')).status, 422);
  assert.equal(normalize(make('EMPTY_FILE', 'No image data received')).status, 400);

  // The curated processor message is preserved (it states the real limit).
  const tooLarge = normalize(make('FILE_TOO_LARGE', 'File size 8.4MB exceeds the 8MB upload limit'));
  assert.match(tooLarge.message, /8\.4MB.*8MB/);
});

test('multer limit errors become 413 with the limit in details', () => {
  const e = Object.assign(new Error('File too large'), { code: 'LIMIT_FILE_SIZE', limit: 5 * 1024 * 1024 });
  const out = normalize(e);
  assert.equal(out.status, 413);
  assert.equal(out.code, 'FILE_TOO_LARGE');
  assert.equal(out.details.maxSizeMB, 5);
  assert.match(out.message, /5 MB/);
});

test('stray multer errors become a 400 upload error, not a 500', () => {
  const out = normalize(Object.assign(new Error('Unexpected field'), { code: 'LIMIT_UNEXPECTED_FILE' }));
  assert.equal(out.status, 400);
  assert.equal(out.code, 'UPLOAD_ERROR');
});

test('body parser rejections map to 413 / 400', () => {
  assert.equal(normalize(Object.assign(new Error('too large'), { type: 'entity.too.large' })).code, 'PAYLOAD_TOO_LARGE');
  const parse = normalize(Object.assign(new Error('Unexpected token'), { type: 'entity.parse.failed' }));
  assert.equal(parse.status, 400);
  assert.equal(parse.code, 'INVALID_JSON');
});

test('mongo duplicate / cast / validation errors map to 409 / 400 / 422', () => {
  assert.equal(normalize(Object.assign(new Error('dup'), { code: 11000 })).code, 'DUPLICATE_KEY');
  assert.equal(normalize(Object.assign(new Error('bad id'), { code: 11000 })).status, 409);

  const cast = Object.assign(new Error('Cast to ObjectId failed'), { name: 'CastError' });
  assert.equal(normalize(cast).status, 400);
  assert.equal(normalize(cast).code, 'INVALID_ID');

  const validation = Object.assign(new Error('validation failed'), {
    name: 'ValidationError',
    errors: { title: { message: 'Path `title` is required.' } },
  });
  const out = normalize(validation);
  assert.equal(out.status, 422);
  assert.equal(out.code, 'VALIDATION_FAILED');
  assert.deepEqual(out.details, [{ field: 'title', message: 'This value is not valid.' }]);
});

test('database outages report 503, not 500', () => {
  const out = normalize(Object.assign(new Error('server selection timeout'), { name: 'MongooseServerSelectionError' }));
  assert.equal(out.status, 503);
  assert.equal(out.code, 'DATABASE_UNAVAILABLE');
});

test('jwt failures report a session message', () => {
  const expired = Object.assign(new Error('jwt expired'), { name: 'TokenExpiredError' });
  assert.equal(normalize(expired).status, 401);
  assert.equal(normalize(expired).code, 'SESSION_EXPIRED');
  assert.match(normalize(expired).message, /session has expired/i);

  const invalid = Object.assign(new Error('invalid signature'), { name: 'JsonWebTokenError' });
  assert.equal(normalize(invalid).code, 'INVALID_TOKEN');
});

test('an unknown exception is a generic 500 with no internals', () => {
  const boom = new Error("Cannot read properties of undefined (reading 'price') at /srv/app/src/x.js:10:3");
  const out = normalize(boom);
  assert.equal(out.status, 500);
  assert.equal(out.code, 'INTERNAL_ERROR');
  assert.equal(out.message, SAFE_500);
  assert.doesNotMatch(out.message, /price|x\.js/);
});

/* ------------------------------------------------------------------ *
 * Part 2 - real HTTP behaviour
 * ------------------------------------------------------------------ */

test('X-Request-Id is echoed and appears in error bodies', async () => {
  const rid = 'test-req-1234567890';
  const res = await fetch(`${BASE}/api/definitely-not-a-route`, { headers: { 'x-request-id': rid } });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('x-request-id'), rid);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.equal(body.error.requestId, rid);
});

test('unsafe inbound request ids are replaced, not trusted', async () => {
  const res = await fetch(`${BASE}/api/definitely-not-a-route`, {
    headers: { 'x-request-id': '<script>alert(1)</script>' },
  });
  const echoed = res.headers.get('x-request-id') || '';
  assert.notEqual(echoed, '<script>alert(1)</script>');
  assert.ok(echoed.length >= 8);
});

test('malformed JSON returns 400 INVALID_JSON as JSON', async () => {
  const res = await fetch(`${BASE}/api/cart`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'INVALID_JSON');
  assert.ok(body.error.requestId);
});

test('unknown API paths never return an HTML error page', async () => {
  const res = await fetch(`${BASE}/api/no/such/endpoint`);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  assert.equal((await res.json()).error.code, 'NOT_FOUND');
});

test('protected endpoints answer 401 with the standard envelope', async () => {
  const res = await fetch(`${BASE}/api/cart`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'AUTH_REQUIRED');
  assert.ok(body.error.message.length > 0);
});

test('legacy {success:false,message} replies gain error.code + requestId', async () => {
  const res = await fetch(`${BASE}/api/products/not-a-valid-id`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.ok(body.message, 'legacy message preserved');
  assert.equal(typeof body.error.code, 'string');
  assert.ok(body.error.requestId);
});

const upload = async (file, filename, type, endpoint = '/api/upload/image') => {
  const fd = new FormData();
  fd.append('image', new Blob([file], { type }), filename);
  return fetch(`${BASE}${endpoint}`, { method: 'POST', body: fd });
};

test('a PDF disguised as an image is rejected with 415', async () => {
  const res = await upload(Buffer.from('%PDF-1.4\n%fake'), 'invoice.pdf', 'application/pdf');
  const body = await res.json();
  assert.equal(res.status, 415, JSON.stringify(body));
  assert.equal(body.error.code, 'UNSUPPORTED_FORMAT');
});

test('a PDF renamed to .png with an image MIME is still rejected (content check, not filename)', async () => {
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF');
  const res = await upload(pdf, 'photo.png', 'image/png');
  const body = await res.json();
  assert.ok([415, 422].includes(res.status), `expected 415/422, got ${res.status}: ${JSON.stringify(body)}`);
  assert.ok(['UNSUPPORTED_FORMAT', 'INVALID_IMAGE', 'IMAGE_PROCESSING_FAILED'].includes(body.error.code));
  assert.ok(!/PDF-1\.7|obj/.test(body.error.message), 'no file content echoed back');
});

test('a corrupted image is rejected with 422', async () => {
  const res = await upload(Buffer.alloc(4096, 0x41), 'broken.png', 'image/png');
  const body = await res.json();
  assert.equal(res.status, 422, JSON.stringify(body));
  assert.ok(['INVALID_IMAGE', 'IMAGE_PROCESSING_FAILED'].includes(body.error.code), body.error.code);
  assert.match(body.error.message, /damaged|could not|unreadable|choose another/i);
});

test('an oversized image is rejected with 413 and states the limit', async () => {
  const big = Buffer.alloc(9 * 1024 * 1024, 0x41);
  const res = await upload(big, 'huge.png', 'image/png');
  const body = await res.json();
  assert.equal(res.status, 413, JSON.stringify(body));
  assert.equal(body.error.code, 'FILE_TOO_LARGE');
  assert.match(body.error.message, /too large/i);
});

test('an empty upload field is a 400 EMPTY_FILE', async () => {
  const res = await fetch(`${BASE}/api/upload/image`, { method: 'POST', body: new FormData() });
  const body = await res.json();
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.equal(body.error.code, 'EMPTY_FILE');
});
