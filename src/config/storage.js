// Centralized storage configuration for the backend.
//
// The application talks to Backblaze B2 through its S3-compatible API using
// the AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`).
// The bucket is PRIVATE: we never generate permanent anonymous URLs. Objects
// are addressed by their object key; a fresh short-lived presigned GET URL is
// minted on the backend whenever a file must be displayed or downloaded.
//
// Everything is read from environment variables — no credentials, bucket
// names, endpoints, or regions are hardcoded anywhere.
//
// Required environment variables:
//   AWS_ACCESS_KEY_ID       -> Backblaze B2 Key ID
//   AWS_SECRET_ACCESS_KEY   -> Backblaze B2 Application Key (secret, server only)
//   AWS_REGION              -> e.g. us-east-005
//   AWS_ENDPOINT            -> https://s3.<region>.backblazeb2.com
//   AWS_S3_BUCKET           -> the private bucket name
//
// Optional:
//   STORAGE_SIGNED_URL_EXPIRES_IN -> presigned URL lifetime in seconds (default 3600)

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const REQUIRED_VARS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'AWS_ENDPOINT',
  'AWS_S3_BUCKET',
];

/**
 * Fail fast at startup when required storage configuration is missing.
 * The error names the missing variables but never reveals any values.
 */
function assertStorageConfig() {
  const missing = REQUIRED_VARS.filter((name) => !String(process.env[name] || '').trim());
  if (missing.length > 0) {
    throw new Error(
      `Storage is not configured: missing required environment variable(s): ${missing.join(', ')}. ` +
        'Set them in backend/.env (see backend/.env.example).'
    );
  }
}

assertStorageConfig();

const region = process.env.AWS_REGION;
const bucket = process.env.AWS_S3_BUCKET;
const endpoint = process.env.AWS_ENDPOINT;

const signedUrlExpiresIn = (() => {
  const n = Number(process.env.STORAGE_SIGNED_URL_EXPIRES_IN);
  return Number.isFinite(n) && n >= 60 ? Math.floor(n) : 3600;
})();

// S3-compatible client pointed at Backblaze B2. Credentials come from the
// standard environment variables (Key ID + Application Key) — never from code.
const s3 = new S3Client({
  region,
  endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

/** Upload a buffer/stream to the private bucket under `key`. */
async function uploadObject({ key, body, contentType }) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
  return key;
}

const EXT_MIME = {
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.bmp': 'image/bmp',
};

// Image file extensions accepted by uploads and image-URL validation.
const IMAGE_EXT_RE = /\.(avif|webp|png|jpe?g|gif|bmp|svgz?|ico|tif{1,2})(?:[?#].*)?$/i;

/**
 * Validate that a value is an image URL (or an image-only storage reference).
 * Accepts:
 *   - app proxy paths (/api/upload/file/... and uploads/...) — uploads are
 *     image-only, so any such reference is an image by construction
 *   - data:image/... URIs
 *   - http(s) URLs whose path ends in an image extension
 * Rejects everything else (PDFs, videos, archives, arbitrary links, etc.).
 */
function isImageUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return false;
  if (raw.startsWith('data:image/')) return true;
  if (raw.startsWith('/api/upload/file/')) return true;
  if (raw.startsWith('uploads/')) return true;
  if (raw.startsWith('/uploads/')) return true;
  if (/^https?:\/\//i.test(raw)) {
    return IMAGE_EXT_RE.test(raw);
  }
  return false;
}

/**
 * Fetch a private object's bytes (used by backfill/reprocessing).
 */
async function getObjectBuffer(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await res.Body.transformToByteArray();
  return { buffer: Buffer.from(bytes), contentType: res.ContentType, length: res.ContentLength };
}

/**
 * Open a stream to a private object (used by the streaming proxy for
 * immutable variants). The caller owns piping/error handling.
 */
async function getObjectStream(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return { body: res.Body, contentType: res.ContentType, contentLength: res.ContentLength, etag: res.ETag };
}

/**
 * Generate a short-lived presigned GET URL for a private object.
 * The URL carries an X-Amz-Signature query parameter — do not log it.
 * Overrides the served Content-Type by key extension when possible, which is
 * needed for objects uploaded without a stored content type (e.g. externally
 * uploaded AVIF images) so browsers render them correctly.
 */
async function getSignedDownloadUrl(key, { expiresIn = signedUrlExpiresIn } = {}) {
  const extDot = String(key || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const contentType = extDot ? EXT_MIME['.' + extDot[1]] : undefined;
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(contentType ? { ResponseContentType: contentType } : {}),
  });
  return getSignedUrl(s3, command, { expiresIn });
}

// ---------------------------------------------------------------------------
// Key safety
// ---------------------------------------------------------------------------

const SAFE_KEY_RE = /^uploads\/[a-zA-Z0-9_./-]+$/;
// Root-level image file keys (e.g. `image.png` at the bucket root) are also
// valid storage references — they are used by seeded/externally-uploaded
// objects that were never placed under the app's `uploads/` namespace.
const ROOT_IMAGE_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(avif|webp|png|jpe?g|gif|bmp|svgz?|ico|tif{1,2})$/i;

/**
 * Validate an object key before it is used in storage operations or served
 * through the proxy route. Rejects path traversal, absolute paths, control
 * characters, backslashes and anything outside the app's `uploads/` namespace
 * (or a root-level image file).
 */
function isSafeKey(key) {
  if (typeof key !== 'string' || !key) return false;
  if (key.length > 1024) return false;
  if (key.includes('..') || key.includes('\\') || key.includes('\u0000')) return false;
  if (/[\u0000-\u001f\u007f]/.test(key)) return false;
  if (key.startsWith('/')) return false;
  return SAFE_KEY_RE.test(key) || ROOT_IMAGE_KEY_RE.test(key);
}

/** Stable, host-agnostic proxy path for an object key. */
function proxyPathFor(key) {
  // Encode each path segment but keep '/' as separators so the Express
  // wildcard route receives a plain, unambiguous key.
  return `/api/upload/file/${String(key)
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')}`;
}

// ---------------------------------------------------------------------------
// URL resolution (backward compatible with legacy stored values)
// ---------------------------------------------------------------------------

const LEGACY_S3_HOST_RE = /^https?:\/\/[^/]+\.s3\.[^/]+\.[^/]+\/(uploads\/.+)$/i;

/** Extract an object key from a legacy full S3/B2 URL, or null. */
function keyFromLegacyUrl(value) {
  const m = LEGACY_S3_HOST_RE.exec(String(value || ''));
  return m ? m[1] : null;
}

/** Build an absolute URL for a path using the incoming request host. */
function absoluteUrl(req, path) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${req.get('host')}${path}`;
}

/**
 * Resolve a stored asset reference to an absolute, usable proxy URL.
 *   - legacy https://<bucket>.s3.<region>.amazonaws.com/<key>  -> proxy URL
 *   - relative proxy path (/api/upload/file/...)                -> absolute proxy URL
 *   - uploads/... or /uploads/... path                          -> proxy URL
 *   - any other absolute URL (external host)                    -> passed through
 */
function resolveAssetUrl(req, value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  if (/^https?:\/\//i.test(raw)) {
    const key = keyFromLegacyUrl(raw);
    if (key && isSafeKey(key)) return absoluteUrl(req, proxyPathFor(key));

    // Re-host absolute proxy URLs to the current request host. The stored
    // value embeds the host that was active at upload time (e.g. localhost in
    // dev); rebuilding against the current host keeps them valid everywhere.
    const proxyMatch = /\/api\/upload\/file\/(.+)$/i.exec(raw);
    if (proxyMatch && isSafeKey(decodeURIComponent(proxyMatch[1]))) {
      return absoluteUrl(req, proxyPathFor(decodeURIComponent(proxyMatch[1])));
    }

    return raw; // external URL — leave untouched
  }

  if (raw.startsWith('/api/upload/file/')) {
    return absoluteUrl(req, raw);
  }

  const normalized = raw.startsWith('/') ? raw.slice(1) : raw;
  if (/^uploads\//.test(normalized) && isSafeKey(normalized)) {
    return absoluteUrl(req, proxyPathFor(normalized));
  }

  // Root-level image file keys (e.g. `image.png`) resolve through the proxy.
  if (isSafeKey(normalized)) {
    return absoluteUrl(req, proxyPathFor(normalized));
  }

  // Preserve the previous behavior: any other server-relative path (e.g.
  // /images/foo.png, /logo.png) becomes absolute against the API host.
  if (raw.startsWith('/')) {
    return absoluteUrl(req, raw);
  }

  return raw;
}

module.exports = {
  s3,
  region,
  bucket,
  endpoint,
  signedUrlExpiresIn,
  assertStorageConfig,
  uploadObject,
  getSignedDownloadUrl,
  getObjectBuffer,
  getObjectStream,
  isSafeKey,
  proxyPathFor,
  resolveAssetUrl,
  absoluteUrl,
  isImageUrl,
  EXT_MIME,
};
