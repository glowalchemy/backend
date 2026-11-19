// Migration: move image references that live OUTSIDE Backblaze B2 into B2.
//
// Handles three kinds of stored references found in MongoDB:
//   1. External http(s) image URLs (e.g. hotlinked CDN images) -> downloaded,
//      optimized through the standard pipeline, rewritten to a proxy URL.
//   2. Legacy S3/B2 absolute URLs -> object key extracted; if the object exists
//      in the bucket the reference is rewritten to the proxy path (no copy).
//   3. Local `uploads/...` / `/uploads/...` keys -> if the object exists in B2
//      the reference is rewritten to the proxy path; if a matching file exists
//      on local disk (public/uploads) it is uploaded first.
//
// Safety:
//   - NON-DESTRUCTIVE: never deletes originals (remote or local files).
//   - IDEMPOTENT: references already pointing at /api/upload/file/ or bare B2
//     keys are skipped, so re-runs converge.
//   - DRY-RUN by default? No — pass --dry-run to report only.
//   - References inside `uploads` docs and order item snapshots are skipped.
//
// Usage:
//   node scripts/migrate-external-images.js --dry-run
//   node scripts/migrate-external-images.js
//   node scripts/migrate-external-images.js --collection=products
//   MIGRATE_CONCURRENCY=2 node scripts/migrate-external-images.js
//
// Never logs credentials or signed URLs.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const axios = require('axios');
const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
const {
  uploadObject,
  proxyPathFor,
  isSafeKey,
  bucket,
  region,
} = require('../src/config/storage');
const { processAndStoreImage } = require('../src/services/imageService');

const CONCURRENCY = Math.max(1, Number(process.env.MIGRATE_CONCURRENCY) || 2);
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;
const LOCAL_UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const onlyCollection = args.find((a) => a.startsWith('--collection='))?.split('=')[1] || null;
  return { dryRun, onlyCollection };
}

// ---------------------------------------------------------------------------
// Reference classification
// ---------------------------------------------------------------------------

const LEGACY_S3_HOST_RE = /^https?:\/\/[^/]+\.s3\.[^/]+\.[^/]+\/(.+)$/i;
const PROXY_PATH_RE = /\/api\/upload\/file\/(.+)$/i;
const IMAGE_EXT_RE = /\.(avif|webp|png|jpe?g|gif|bmp|svgz?|ico|tif{1,2})(?:[?#].*)?$/i;

/** Returns 'ours' | 'legacy-s3' | 'external' | 'local-key' | 'skip'. */
function classify(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'skip';
  if (raw.startsWith('/api/upload/file/')) return 'ours';
  if (raw.startsWith('data:')) return 'skip';

  if (/^https?:\/\//i.test(raw)) {
    if (PROXY_PATH_RE.test(raw)) return 'ours';
    if (LEGACY_S3_HOST_RE.test(raw)) return 'legacy-s3';
    return IMAGE_EXT_RE.test(raw) ? 'external' : 'skip';
  }

  const normalized = raw.startsWith('/') ? raw.slice(1) : raw;
  if (isSafeKey(normalized)) return 'local-key';
  if (normalized.startsWith('uploads/')) return 'local-key';
  return 'skip';
}

function keyFromValue(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (PROXY_PATH_RE.test(raw)) {
    const key = decodeURIComponent(PROXY_PATH_RE.exec(raw)[1]);
    return isSafeKey(key) ? key : null;
  }
  if (LEGACY_S3_HOST_RE.test(raw)) {
    const key = decodeURIComponent(LEGACY_S3_HOST_RE.exec(raw)[1]);
    return isSafeKey(key) ? key : null;
  }
  const normalized = raw.startsWith('/') ? raw.slice(1) : raw;
  return isSafeKey(normalized) ? normalized : null;
}

// ---------------------------------------------------------------------------
// Field map: collection -> list of { path, kind }
//   kind 'string'  -> single string field
//   kind 'array'   -> array of strings
//   kind 'media'   -> array of objects with .url (management.media.images)
//   kind 'nested'  -> array of subdocuments containing .images[] (colorVariants, reviews)
// ---------------------------------------------------------------------------

const FIELD_MAP = [
  {
    collection: 'products',
    fields: [
      { path: 'image', kind: 'string' },
      { path: 'galleryImages', kind: 'array' },
      { path: 'colorVariants', kind: 'nested-images' },
      { path: 'reviews', kind: 'nested-images' },
      { path: 'management.media.images', kind: 'media' },
    ],
  },
  { collection: 'categories', fields: [{ path: 'imageUrl', kind: 'string' }] },
  { collection: 'banners', fields: [{ path: 'image', kind: 'string' }] },
  {
    collection: 'contentsettings',
    fields: [
      { path: 'brandLogoUrl', kind: 'string' },
      { path: 'defaultAvatarUrl', kind: 'string' },
    ],
  },
  { collection: 'users', fields: [{ path: 'avatarUrl', kind: 'string' }] },
];

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

/** Collect { setPath, value } for every image reference in a document. */
function collectImageRefs(doc, fields) {
  const refs = [];
  for (const f of fields) {
    const value = getPath(doc, f.path);
    const push = (setPath, v) => {
      const s = String(v ?? '').trim();
      if (s) refs.push({ setPath, value: s });
    };

    if (f.kind === 'string') {
      push(f.path, value);
    } else if (f.kind === 'array') {
      if (Array.isArray(value)) value.forEach((v, i) => push(`${f.path}.${i}`, v));
    } else if (f.kind === 'media') {
      if (Array.isArray(value)) value.forEach((item, i) => item && push(`${f.path}.${i}.url`, item.url));
    } else if (f.kind === 'nested-images') {
      if (Array.isArray(value)) {
        value.forEach((sub, i) => {
          const imgs = sub && Array.isArray(sub.images) ? sub.images : [];
          imgs.forEach((v, j) => push(`${f.path}.${i}.images.${j}`, v));
        });
      }
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

const s3 = new S3Client({
  region,
  endpoint: process.env.AWS_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function objectExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Minimal req stub so processAndStoreImage can build absolute URLs. */
const FAKE_REQ = {
  headers: {},
  protocol: 'https',
  get: () => process.env.API_PUBLIC_HOST || 'localhost',
};

async function fetchExternalImage(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxContentLength: MAX_DOWNLOAD_BYTES,
    maxBodyLength: MAX_DOWNLOAD_BYTES,
    headers: { 'User-Agent': 'GlowAlchemy-Migration/1.0' },
    validateStatus: (s) => s >= 200 && s < 400,
  });
  const buffer = Buffer.from(res.data);
  if (!buffer.length) throw new Error('empty response body');
  const contentType = String(res.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
  return { buffer, contentType };
}

/**
 * Resolve a stored reference to a B2-backed proxy reference.
 * Returns { proxyRef } on success or { error } on failure. Never throws.
 */
async function resolveToB2(value, stats) {
  const kind = classify(value);

  if (kind === 'ours') return { proxyRef: value };
  if (kind === 'skip') return { skipped: true };

  if (kind === 'legacy-s3' || kind === 'local-key') {
    const key = keyFromValue(value);
    if (!key) return { skipped: true };
    if (await objectExists(key)) {
      return { proxyRef: proxyPathFor(key) };
    }
    // local-key may still exist on disk under public/uploads/<basename>
    if (kind === 'local-key') {
      const filePath = path.join(LOCAL_UPLOADS_DIR, path.basename(key));
      try {
        if (fs.existsSync(filePath)) {
          const buffer = fs.readFileSync(filePath);
          const ext = path.extname(filePath).toLowerCase().replace('.', '') || 'bin';
          await uploadObject({ key, body: buffer, contentType: guessMime(ext) });
          stats.localUploads += 1;
          return { proxyRef: proxyPathFor(key) };
        }
      } catch (err) {
        return { error: `local upload failed: ${err.message}` };
      }
    }
    return { error: kind === 'legacy-s3' ? 'legacy S3 object missing in bucket' : 'object missing in bucket and no local file' };
  }

  // external http(s) image URL
  try {
    const { buffer, contentType } = await fetchExternalImage(value);
    const name = decodeURIComponent(value.split('?')[0].split('/').pop() || 'external-image');
    const result = await processAndStoreImage({
      buffer,
      mimetype: contentType.startsWith('image/') ? contentType : 'application/octet-stream',
      originalName: name,
      folder: 'migrated',
      req: FAKE_REQ,
    });
    stats.externalMigrated += 1;
    return { proxyRef: result.url };
  } catch (err) {
    return { error: `external fetch/process failed: ${err && err.message ? err.message : err}` };
  }
}

function guessMime(ext) {
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp',
    tif: 'image/tiff', tiff: 'image/tiff', ico: 'image/x-icon',
  };
  return map[ext] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { dryRun, onlyCollection } = parseArgs();

  if (!process.env.MONGODB_URI) {
    console.error('Missing MONGODB_URI in backend/.env');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;

  const stats = { scanned: 0, rewritten: 0, skipped: 0, failed: 0, localUploads: 0, externalMigrated: 0 };
  const targets = FIELD_MAP.filter((t) => !onlyCollection || t.collection === onlyCollection);

  for (const target of targets) {
    const docs = await db.collection(target.collection).find({}).batchSize(200).toArray();
    console.log(`${target.collection}: ${docs.length} document(s)`);

    for (const doc of docs) {
      stats.scanned += 1;
      const updates = [];

      for (const ref of collectImageRefs(doc, target.fields)) {
        const kind = classify(ref.value);
        if (kind === 'ours' || kind === 'skip') {
          stats.skipped += 1;
          continue;
        }

        if (dryRun) {
          console.log(`  [dry-run] ${target.collection}/${doc._id} ${ref.setPath}: ${kind} <- ${String(ref.value).slice(0, 120)}`);
          stats.rewritten += 1;
          continue;
        }

        const res = await resolveToB2(ref.value, stats);
        if (res.proxyRef && res.proxyRef !== ref.value) {
          updates.push({ setPath: ref.setPath, value: res.proxyRef });
        } else if (res.error) {
          console.error(`  failed ${target.collection}/${doc._id} ${ref.setPath}: ${res.error}`);
          stats.failed += 1;
        } else {
          stats.skipped += 1;
        }
      }

      if (updates.length > 0) {
        const $set = {};
        for (const u of updates) $set[u.setPath] = u.value;
        await db.collection(target.collection).updateOne({ _id: doc._id }, { $set });
        stats.rewritten += updates.length;
        console.log(`  updated ${target.collection}/${doc._id}: ${updates.length} ref(s)`);
      }
    }
  }

  console.log('\nDone.');
  console.log(JSON.stringify(stats, null, 2));
  await mongoose.disconnect();
  process.exit(stats.failed > 0 && !dryRun ? 1 : 0);
}

main().catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});
