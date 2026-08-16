/**
 * importService.js
 *
 * Canonical import pipeline abstraction for external product sources
 * (CSV / JSON / Excel / supplier API / external DB).
 *
 *   External Source → rows → normalizeRow() → validate() → upsert by stable
 *   identity (SKU) → MongoDB (via existing product business rules)
 *
 * Guarantees:
 *  - idempotent: re-importing the same source does not create duplicates
 *    (identity = SKU, optionally + sourceId)
 *  - resumable: accepts an offset and reports progress per batch
 *  - batch-based: never one HTTP request per document
 *  - validated: goes through the same category/subcategory/image validation
 *    rules as the admin flow (no validation bypass)
 *  - non-destructive by default: never deletes or overwrites unless --update
 */

const mongoose = require('mongoose');
const { CategoryModel } = require('../models/category');
const { syncSearchProjection } = require('./productNormalizer');
const cacheService = require('./cacheService');

const DEFAULT_BATCH_SIZE = 50;

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toStr(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function slugify(text) {
  return toStr(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/**
 * Normalize one external row into the canonical product document shape.
 * Map external field names (title, selling_price, qty, category_name, ...)
 * to the app's product document structure.
 */
function normalizeRow(row, options = {}) {
  const source = options.source || 'import';
  const sku = toStr(row.sku) || toStr(row.SKU) || '';
  const name = toStr(row.title) || toStr(row.name) || toStr(row.product_name) || '';
  if (!name) throw new Error(`Row missing name/title (${JSON.stringify(row).slice(0, 120)})`);
  if (!sku) throw new Error(`Row missing sku — stable identity required (${name.slice(0, 60)})`);

  const price = toNum(row.selling_price ?? row.price ?? row.mrp ?? row.sellingPrice, 0);
  const originalPrice = toNum(row.mrp ?? row.original_price ?? row.compare_at_price ?? row.originalPrice, price);
  const stock = toNum(row.qty ?? row.stock ?? row.quantity ?? row.stock_quantity, 0);
  const brand = toStr(row.brand);
  const categoryName = toStr(row.category) || toStr(row.category_name);
  const subCategoryName = toStr(row.subcategory) || toStr(row.sub_category) || toStr(row.subcategory_name);
  const description = toStr(row.description) || toStr(row.short_description) || '';
  const image = toStr(row.image) || toStr(row.image_url) || toStr(row.image_link) || '';
  const images = Array.isArray(row.images)
    ? row.images.map((u) => toStr(u)).filter(Boolean)
    : (toStr(row.additional_images) ? toStr(row.additional_images).split(/[|,;]/).map((u) => u.trim()).filter(Boolean) : []);
  const tags = Array.isArray(row.tags)
    ? row.tags.map((t) => toStr(t)).filter(Boolean)
    : (toStr(row.tags) ? toStr(row.tags).split(/[|,;]/).map((t) => t.trim()).filter(Boolean) : []);
  const weight = toNum(row.weight_kg ?? row.weight, 0);
  const length = toNum(row.length_cm ?? row.length, 0);
  const width = toNum(row.width_cm ?? row.width, 0);
  const height = toNum(row.height_cm ?? row.height, 0);
  const freeShipping = toStr(row.free_shipping).toLowerCase() === 'true' || row.freeShipping === true;
  const codAvailable = toStr(row.cod).toLowerCase() === 'true' || row.codAvailable === true;
  const codCharge = toNum(row.cod_charge, 0);
  const shippingCharge = toNum(row.shipping_charge, 0);
  const status = toStr(row.status).toLowerCase() === 'draft' ? 'draft' : 'active';
  const sizes = Array.isArray(row.sizes) ? row.sizes.map((s) => toStr(s)).filter(Boolean) : [];
  const colors = Array.isArray(row.colors) ? row.colors.map((c) => toStr(c)).filter(Boolean) : [];
  const saleEnabled = toStr(row.sale).toLowerCase() === 'true' || row.saleEnabled === true;
  const saleDiscount = toNum(row.discount_percent, 0);
  const sourceId = toStr(row.source_id) || toStr(row.supplier_product_id) || '';

  // Attribute sets (dynamic, category-agnostic). A row may carry
  // attributes = [{name, values}], or flat attribute_* / attributes_json.
  let attributeSets = [];
  if (Array.isArray(row.attributes)) {
    attributeSets = row.attributes
      .map((a) => ({ id: toStr(a.id), name: toStr(a.name), values: Array.isArray(a.values) ? a.values.map((v) => toStr(v)).filter(Boolean) : [], filterable: !!(a && a.filterable) }))
      .filter((a) => a.name);
  } else if (toStr(row.attributes_json)) {
    try {
      const parsed = JSON.parse(toStr(row.attributes_json));
      if (Array.isArray(parsed)) attributeSets = parsed.map((a) => ({ id: toStr(a.id), name: toStr(a.name), values: Array.isArray(a.values) ? a.values.map((v) => toStr(v)).filter(Boolean) : [] })).filter((a) => a.name);
    } catch (_e) { /* ignore malformed json */ }
  }

  const categoryIds = [];
  const basic = {
    name,
    shortDescription: description,
    descriptionHtml: toStr(row.description_html) || '',
    brand: brand || 'Trozzi',
    visibility: 'public',
    status,
    categoryIds,
    subCategoryId: '',
    slug: toStr(row.slug) || slugify(name),
  };
  const management = {
    basic,
    pricing: { sellingPrice: price, originalPrice, compareAtPrice: originalPrice > price ? originalPrice : 0 },
    inventory: { sku, stockQuantity: stock },
    media: { images: images.map((u, i) => ({ id: `import-${i}`, url: u, alt: name })), thumbnailId: images.length ? 'import-0' : '' },
    attributes: { sets: attributeSets },
    seo: { metaTitle: toStr(row.meta_title) || name, metaDescription: toStr(row.meta_description) || description.slice(0, 160) },
    shipping: { weightKg: weight, dimensionsCm: { length, width, height }, freeShipping, codAvailable, codCharge, shippingCharge },
    marketing: { featured: toStr(row.featured).toLowerCase() === 'true' },
    salePage: { enabled: false },
  };

  return {
    _source: { source, sourceId, rawName: name },
    categoryName,
    subCategoryName,
    sizes,
    colors,
    tags,
    saleEnabled,
    saleDiscount,
    slug: basic.slug,
    price,
    stock,
    management,
  };
}

/**
 * Validate the normalized import (category/subcategory must resolve to real
 * records; images must be URLs). Throws on invalid rows.
 */
async function validateRow(importRow) {
  const { management, categoryName, subCategoryName } = importRow;
  const media = management.media || {};
  for (const img of media.images || []) {
    const url = String((img && img.url) || '').trim();
    if (!url) continue;
    if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) {
      throw new Error(`Invalid image URL: ${url.slice(0, 80)}`);
    }
  }
  if (categoryName) {
    const cat = await CategoryModel.findOne({ $or: [{ name: categoryName }, { slug: categoryName }] }).lean();
    if (!cat) throw new Error(`Category not found: ${categoryName}`);
    management.basic.categoryIds = [String(cat._id)];
  }
  if (subCategoryName) {
    const sub = await CategoryModel.findOne({ $or: [{ name: subCategoryName }, { slug: subCategoryName }] }).lean();
    if (!sub) throw new Error(`Subcategory not found: ${subCategoryName}`);
    if (!sub.parentId) throw new Error(`'${subCategoryName}' is a top-level category, not a subcategory`);
    management.basic.subCategoryId = String(sub._id);
    if (!management.basic.categoryIds.length) management.basic.categoryIds = [String(sub.parentId)];
  }
}

/**
 * Import rows into MongoDB.
 *
 * @param {Array<Object>} rows normalized rows (or raw rows when raw=true)
 * @param {Object} opts { dryRun, update, batchSize, onProgress, defaultStatus }
 * @returns {Promise<{imported, updated, skipped, failed, errors, processed}>}
 */
async function importProducts(rows, opts = {}) {
  const dryRun = !!opts.dryRun;
  const updateExisting = !!opts.update;
  const batchSize = Math.min(200, Math.max(1, Number(opts.batchSize) || DEFAULT_BATCH_SIZE));
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const startIndex = Math.max(0, Number(opts.offset) || 0);

  const db = mongoose.connection.db;
  const stats = { imported: 0, updated: 0, skipped: 0, failed: 0, errors: [], processed: 0 };
  const now = new Date();
  // In-batch dedupe by SKU so duplicate rows in one import are never double-
  // counted (essential for dry-run, where nothing is persisted between rows).
  const seenSkus = new Set();

  const total = rows.length;
  for (let i = startIndex; i < total; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    for (const raw of batch) {
      stats.processed += 1;
      try {
        const importRow = normalizeRow(raw, { source: opts.source });
        await validateRow(importRow);
        const { management } = importRow;
        const sku = management.inventory.sku;

        if (seenSkus.has(sku)) {
          stats.skipped += 1;
          continue;
        }
        seenSkus.add(sku);

        const existing = await db.collection('products').findOne({ sku }, { projection: { _id: 1 } });

        const doc = {
          slug: importRow.slug,
          visibility: 'public',
          name: management.basic.name,
          sku,
          price: importRow.price,
          originalPrice: management.pricing.originalPrice || importRow.price,
          stock: importRow.stock,
          status: 'active',
          image: (management.media.images[0] && management.media.images[0].url) || '',
          galleryImages: management.media.images.slice(1).map((img) => img.url),
          category: management.basic.categoryIds[0] || '',
          description: management.basic.shortDescription || '',
          featured: !!management.marketing.featured,
          freeShipping: !!management.shipping.freeShipping,
          codAvailable: !!management.shipping.codAvailable,
          codCharge: management.shipping.codCharge || 0,
          shippingCharge: management.shipping.shippingCharge || 0,
          weight: management.shipping.weightKg || 0,
          dimensions: management.shipping.dimensionsCm || { length: 0, width: 0, height: 0 },
          sizes: importRow.sizes,
          colors: importRow.colors,
          tags: importRow.tags,
          saleEnabled: importRow.saleEnabled,
          saleDiscount: importRow.saleDiscount || 0,
          management,
          updatedAt: now,
        };

        if (existing) {
          if (!updateExisting) {
            stats.skipped += 1;
            continue;
          }
          if (dryRun) { stats.updated += 1; continue; }
          await db.collection('products').updateOne({ _id: existing._id }, { $set: doc });
          stats.updated += 1;
          continue;
        }

        if (dryRun) { stats.imported += 1; continue; }
        const inserted = await db.collection('products').insertOne({ ...doc, createdAt: now });
        syncSearchProjection({ ...doc, _id: inserted.insertedId });
        stats.imported += 1;
      } catch (err) {
        stats.failed += 1;
        stats.errors.push({ index: i + (stats.processed % batchSize), message: err.message });
        if (stats.errors.length > 20) break;
      }
    }
    if (!dryRun) cacheService.invalidateAll();
    onProgress({ processed: Math.min(startIndex + stats.processed, total), total, stats: { ...stats } });
  }

  return stats;
}

module.exports = { normalizeRow, validateRow, importProducts, slugify };
