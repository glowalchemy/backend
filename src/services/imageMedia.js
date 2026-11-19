// Image media resolution: attaches responsive variant metadata (320/640/1200,
// AVIF + WebP) to stored image references by joining against the `uploads`
// collection. Batched per request to avoid N+1 lookups.
//
// A stored reference may be:
//   - a relative proxy path        (/api/upload/file/<key>)
//   - an absolute proxy URL        (http(s)://host/api/upload/file/<key>)
//   - a bare key                   (uploads/..., image.png)
//   - a legacy S3/B2 URL           (https://<bucket>.s3.<region>.amazonaws.com/<key>)
//   - an external URL              (passed through untouched)
//
// Variants are returned as absolute proxy URLs so the frontend can build
// <picture>/srcset without any derivation logic. Legacy objects without
// variants return variants: null and the frontend falls back to a plain img.

const mongoose = require('mongoose');
const {
  proxyPathFor,
  absoluteUrl,
  isSafeKey,
  resolveAssetUrl,
  deleteObjects,
} = require('../config/storage');
const { isOptimizedAssetKey, assetIdFromKey } = require('./imageProcessor');
const { UploadModel } = require('../models/upload');

const LEGACY_S3_HOST_RE = /^https?:\/\/[^/]+\.s3\.[^/]+\.[^/]+\/(uploads\/.+)$/i;

/** Extract the storage object key from a stored image reference, or null. */
function keyFromStoredValue(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    const legacy = LEGACY_S3_HOST_RE.exec(raw);
    if (legacy && isSafeKey(legacy[1])) return decodeURIComponent(legacy[1]);
    const proxy = /\/api\/upload\/file\/(.+)$/i.exec(raw);
    if (proxy && isSafeKey(decodeURIComponent(proxy[1]))) return decodeURIComponent(proxy[1]);
    return null; // external URL
  }

  if (raw.startsWith('/api/upload/file/')) {
    const key = decodeURIComponent(raw.slice('/api/upload/file/'.length));
    return isSafeKey(key) ? key : null;
  }

  const normalized = raw.startsWith('/') ? raw.slice(1) : raw;
  if (isSafeKey(normalized)) return normalized;

  return null;
}

/**
 * Load uploads documents for a set of stored references in ONE query.
 * Returns { byKey, byAssetId, byValue } maps.
 */
async function loadUploadsMap(values) {
  const keys = [];
  const assetIds = [];
  for (const value of values || []) {
    const key = keyFromStoredValue(value);
    if (!key) continue;
    keys.push(key);
    if (isOptimizedAssetKey(key)) {
      const id = assetIdFromKey(key);
      if (id) assetIds.push(id);
    }
  }
  const result = { byKey: new Map(), byAssetId: new Map(), byValue: new Map() };
  if (keys.length === 0) return result;

  try {
    const db = mongoose.connection.db;
    if (!db) return result;
    const docs = await db
      .collection('uploads')
      .find({
        $or: [
          { key: { $in: keys } },
          ...(assetIds.length ? [{ assetId: { $in: assetIds } }] : []),
        ],
      })
      .limit(500)
      .toArray();
    for (const doc of docs) {
      if (doc && doc.key) result.byKey.set(String(doc.key), doc);
      if (doc && doc.assetId) result.byAssetId.set(String(doc.assetId), doc);
    }
  } catch (err) {
    console.error('Uploads lookup failed:', err && err.message ? err.message : err);
  }
  return result;
}

/** Build a variants map { slot: { avif, webp, width } } of ABSOLUTE proxy URLs. */
function buildVariants(req, doc) {
  const variants = Array.isArray(doc && doc.variants) ? doc.variants : [];
  if (variants.length === 0) return null;

  const map = {};
  for (const v of variants) {
    const slot = Number(v && v.slot);
    const key = String(v && v.key || '');
    const format = String(v && v.format || '');
    if (!Number.isInteger(slot) || !key || !isSafeKey(key) || !format) continue;
    map[slot] = map[slot] || { slot, width: Number(v.width) || slot };
    map[slot][format] = absoluteUrl(req, proxyPathFor(key));
  }
  const entries = Object.values(map).filter((m) => m.avif || m.webp);
  return entries.length ? map : null;
}

/** Primary (largest) optimized variant key for a doc, else the original key. */
function primaryKeyFor(doc) {
  if (!doc) return null;
  if (String(doc.primaryKey || '').trim() && isSafeKey(doc.primaryKey)) return doc.primaryKey;
  if (String(doc.key || '').trim() && isSafeKey(doc.key)) return doc.key;
  return null;
}

/**
 * Resolve one stored reference to { url, variants, width, height }.
 * `url` is the primary display URL (largest optimized variant when available,
 * otherwise the plain resolved proxy URL).
 */
function resolveMediaForValue(req, value, uploadsMap) {
  const raw = String(value ?? '').trim();
  if (!raw) return { url: '', variants: null, width: null, height: null };

  const key = keyFromStoredValue(raw);
  if (!key) {
    // External URL or unresolvable — pass through with no variants.
    return { url: resolveAssetUrl(req, raw), variants: null, width: null, height: null };
  }

  let doc = uploadsMap.byKey.get(key);
  if (!doc && isOptimizedAssetKey(key)) {
    const id = assetIdFromKey(key);
    if (id) doc = uploadsMap.byAssetId.get(id);
  }

  const variants = doc ? buildVariants(req, doc) : null;
  const primaryKey = doc ? primaryKeyFor(doc) : key;
  const url = primaryKey ? absoluteUrl(req, proxyPathFor(primaryKey)) : resolveAssetUrl(req, raw);

  return {
    url,
    variants,
    width: doc && Number(doc.width) > 0 ? Number(doc.width) : null,
    height: doc && Number(doc.height) > 0 ? Number(doc.height) : null,
  };
}

/** Batch: load docs once, then resolve every value. */
async function resolveMediaForValues(req, values) {
  const list = Array.isArray(values) ? values : [];
  const uploadsMap = await loadUploadsMap(list);
  return list.map((v) => resolveMediaForValue(req, v, uploadsMap));
}

/** Single-value convenience wrapper. */
async function resolveMediaForUrl(req, value) {
  const [media] = await resolveMediaForValues(req, [value]);
  return media;
}

/**
 * Best-effort deletion of the storage object(s) behind a stored asset
 * reference (used when the last known reference — banner, category — is
 * permanently deleted). Skips external URLs and objects still referenced by
 * a Media Library `uploads` document (shared assets). Never throws.
 */
async function deleteAssetIfUnreferenced(value) {
  try {
    const key = keyFromStoredValue(value);
    if (!key || !isSafeKey(key)) return { deleted: false };

    const shared = await UploadModel.exists({
      $or: [{ key }, { primaryKey: key }, { originalKey: key }, { 'variants.key': key }],
    });
    if (shared) return { deleted: false };

    await deleteObjects([key]);
    return { deleted: true };
  } catch (error) {
    console.error('Asset cleanup failed:', error && error.message ? error.message : error);
    return { deleted: false };
  }
}

module.exports = {
  keyFromStoredValue,
  loadUploadsMap,
  resolveMediaForValue,
  resolveMediaForValues,
  resolveMediaForUrl,
  deleteAssetIfUnreferenced,
};
