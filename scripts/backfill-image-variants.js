// Backfill: generate optimized variants for EXISTING private B2 objects.
//
// Safe by design:
//   - NON-DESTRUCTIVE: never deletes or overwrites originals. Only ADDS
//     immutable variant objects under uploads/<folder>/<assetId>/<slot>.* and
//     upserts an `uploads` document with canonical metadata.
//   - IDEMPOTENT + RESUMABLE: skips keys that already have a completed
//     `uploads` doc (matching `key`), so interrupted runs can be re-run.
//   - RATE-LIMITED: processes with bounded concurrency (default 2).
//   - No reference rewriting: existing product/cart/feed references keep
//     working — the media layer resolves variants by object key at read time,
//     so legacy refs (e.g. `image.png`) automatically gain responsive
//     variants after this script runs. `--rewrite` is intentionally NOT
//     implemented: stored references do not need to change.
//
// Usage:
//   node scripts/backfill-image-variants.js                 # all eligible objects
//   node scripts/backfill-image-variants.js --key image.png # single key
//   node scripts/backfill-image-variants.js --dry-run       # report only
//   BACKFILL_CONCURRENCY=2 node scripts/backfill-image-variants.js
//
// Never logs signed URLs or credentials.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const {
  uploadObject,
  getObjectBuffer,
  bucket,
  region,
  isSafeKey,
  proxyPathFor,
} = require('../src/config/storage');
const {
  validateImageUpload,
  generateVariantBuffers,
  buildAssetKeys,
  newAssetId,
  isVariantObjectKey,
  isOptimizedAssetKey,
} = require('../src/services/imageProcessor');
const { UploadModel } = require('../src/models/upload');

const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY) || 2);

function parseArgs() {
  const args = process.argv.slice(2);
  const onlyKey = args.find((a) => a.startsWith('--key='))?.split('=')[1];
  const dryRun = args.includes('--dry-run');
  return { onlyKey: onlyKey ? decodeURIComponent(onlyKey) : null, dryRun };
}

async function listAllObjects(s3) {
  const keys = [];
  let continuationToken;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      })
    );
    for (const o of res.Contents || []) {
      if (o.Key) keys.push({ key: String(o.Key), size: o.Size || 0 });
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

/** Decide whether an object key is eligible for backfill. */
function isEligible(key) {
  if (!isSafeKey(key)) return false;
  if (isVariantObjectKey(key)) return false; // already an optimized variant
  // Only image files (root-level image keys or uploads/* originals).
  if (/^uploads\//.test(key)) {
    const base = key.split('/').pop() || '';
    return /^original\.(avif|webp|png|jpe?g|gif|bmp|svgz?|ico|tif{1,2})$/i.test(base);
  }
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(avif|webp|png|jpe?g|gif|bmp|svgz?|ico|tif{1,2})$/i.test(key);
}

async function hasCompletedDoc(key) {
  const existing = await UploadModel.findOne({ key: String(key) }).lean();
  return Boolean(existing && Array.isArray(existing.variants) && existing.variants.length > 0);
}

async function processKey({ key, s3, dryRun, stats }) {
  if (dryRun) {
    console.log(`[dry-run] would process ${key}`);
    return;
  }
  if (await hasCompletedDoc(key)) {
    console.log(`skip (already optimized): ${key}`);
    stats.skipped += 1;
    return;
  }

  let data;
  try {
    data = await getObjectBuffer(key);
  } catch (err) {
    console.error(`fetch failed (skipped, resumable): ${key} — ${err?.message || err}`);
    stats.failed += 1;
    return;
  }

  let meta;
  try {
    meta = await validateImageUpload({ buffer: data.buffer, size: data.length });
  } catch (err) {
    console.error(`validate failed (skipped): ${key} — ${err?.message || err}`);
    stats.failed += 1;
    return;
  }

  const ext = meta.format === 'jpeg' ? 'jpg' : meta.format === 'tiff' ? 'tif' : meta.format;
  const assetId = newAssetId();
  const folder = key.startsWith('uploads/') ? key.split('/')[1] : 'legacy';
  const keys = buildAssetKeys({ folder, assetId, ext });

  let variants;
  try {
    variants = await generateVariantBuffers(data.buffer, meta.width);
  } catch (err) {
    console.error(`variant generation failed (skipped, resumable): ${key} — ${err?.message || err}`);
    stats.failed += 1;
    return;
  }

  const variantRecords = [];
  for (const v of variants) {
    const vKey = keys.variant(v.slot, v.format);
    try {
      await uploadObject({ key: vKey, body: v.buffer, contentType: `image/${v.format}` });
      variantRecords.push({ slot: v.slot, width: v.width, format: v.format, key: vKey });
    } catch (err) {
      console.error(`variant upload failed (skipped, resumable): ${vKey} — ${err?.message || err}`);
      stats.failed += 1;
      return;
    }
  }

  const primaryRecord = variantRecords
    .filter((r) => r.format === 'webp')
    .sort((a, b) => b.slot - a.slot)[0];
  const primaryKey = primaryRecord ? primaryRecord.key : key;

  // Upsert: `key` matches the ORIGINAL object so the media layer resolves
  // variants for legacy references; re-runs converge (idempotent).
  await UploadModel.updateOne(
    { key: String(key) },
    {
      $set: {
        url: proxyPathFor(primaryKey),
        bucket,
        region,
        contentType: data.contentType || 'application/octet-stream',
        size: data.length,
        originalName: key.split('/').pop() || key,
        assetId,
        folder,
        primaryKey,
        originalKey: String(key),
        width: meta.width,
        height: meta.height,
        format: meta.format,
        variants: variantRecords,
      },
    },
    { upsert: true }
  );

  console.log(`optimized: ${key} -> ${variantRecords.length} variants (${variantRecords.map((v) => v.width).join(', ')})`);
  stats.optimized += 1;
}

async function main() {
  const { onlyKey, dryRun } = parseArgs();

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('Missing MONGODB_URI in backend/.env');
    process.exit(1);
  }
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 15000 });

  const s3 = new S3Client({
    region,
    endpoint: process.env.AWS_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });

  let targets;
  if (onlyKey) {
    targets = [{ key: onlyKey, size: 0 }];
    if (!isEligible(onlyKey)) {
      console.error(`Key not eligible for backfill: ${onlyKey}`);
      await mongoose.disconnect();
      process.exit(1);
    }
  } else {
    targets = (await listAllObjects(s3)).filter((o) => isEligible(o.key));
  }

  console.log(`Backfill target: ${targets.length} object(s) (concurrency ${CONCURRENCY}, dry-run: ${dryRun})`);
  for (const t of targets) console.log(`  - ${t.key} (${t.size} B)`);

  const stats = { optimized: 0, skipped: 0, failed: 0 };
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(1, targets.length)) }, async () => {
    while (cursor < targets.length) {
      const target = targets[cursor];
      cursor += 1;
      await processKey({ key: target.key, s3, dryRun, stats });
    }
  });
  await Promise.all(workers);

  console.log(`\nDone. optimized=${stats.optimized} skipped=${stats.skipped} failed=${stats.failed}`);
  await mongoose.disconnect();
  process.exit(stats.failed > 0 && !dryRun ? 1 : 0);
}

main().catch((err) => {
  console.error('Backfill error:', err);
  process.exit(1);
});
