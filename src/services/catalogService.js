/**
 * catalogService.js
 *
 * ONE authoritative catalog query service. Every listing/search/filter/sort/
 * pagination path in the app goes through this module (storefront listing,
 * admin grid, category counts, facets, suggestions).
 *
 * Responsibilities:
 *  - whitelist filter/sort parsing (never trust raw Mongo operators from the client)
 *  - projection so listings never transfer the full product document
 *  - product → canonical domain → API mapping (via productNormalizer)
 *  - facet aggregation (single $facet, filter-aware)
 *  - category counts in ONE aggregation (no N+1)
 *  - bounded in-process TTL caching for safe public responses
 */

const mongoose = require('mongoose');
const { resolveAssetUrl } = require('../config/storage');
const { resolveMediaForValues } = require('./imageMedia');
const { CategoryModel } = require('../models/category');
const { ProductModel } = require('../models/product');
const { normalizeProduct, toFiniteNumber, toTrimmedString } = require('./productNormalizer');
const { buildSearchFilter, rankProducts, minCharsSetting, candidateCap } = require('./searchService');
const cacheService = require('./cacheService');

// ---------------------------------------------------------------------------
// Small parsing helpers (moved here so all routes share one implementation)
// ---------------------------------------------------------------------------

function parseIntQuery(value) {
  if (value === undefined || value === null) return undefined;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function parseCsvQuery(value) {
  if (value === undefined || value === null) return [];
  return String(value).split(',').map((v) => String(v).trim()).filter((v) => v.length > 0);
}

function toBool(value) {
  return String(value ?? '').toLowerCase() === 'true';
}

// ---------------------------------------------------------------------------
// Authoritative public visibility filter — shared by listing, counts, facets.
// ---------------------------------------------------------------------------

function publicBaseFilter(mode) {
  const filter = {};
  if (mode !== 'admin') {
    filter.status = { $in: ['active', 'published'] };
    filter.$or = [
      { visibility: 'public' },
      { visibility: { $exists: false } },
      { visibility: null },
      { 'management.basic.visibility': 'public' },
      { 'management.basic.visibility': { $exists: false } },
      { 'management.basic.visibility': null },
    ];
  }
  return filter;
}

// ---------------------------------------------------------------------------
// Field projection for basic listings (home page, sliders, etc.)
// Only essential fields to reduce payload size
// ---------------------------------------------------------------------------

const BASIC_PROJECTION = {
  _id: 1, slug: 1, name: 1, price: 1, originalPrice: 1, stock: 1, status: 1,
  image: 1, galleryImages: 1, category: 1, featured: 1, rating: 1,
  sizes: 1, colors: 1, tags: 1, saleEnabled: 1, saleDiscount: 1,
  'management.basic': 1, 'management.pricing': 1, 'management.inventory': 1, 'management.media': 1,
  'management.marketing.featured': 1, 'management.marketing.badge': 1,
  'management.shipping.freeShipping': 1,
  'management.salePage.enabled': 1, 'management.salePage.bannerText': 1,
};

// ---------------------------------------------------------------------------
// Field projection for search suggestions (autocomplete)
// Minimal fields needed for search dropdown display
// ---------------------------------------------------------------------------

const SEARCH_SUGGEST_PROJECTION = {
  _id: 1, slug: 1, name: 1, price: 1, originalPrice: 1, image: 1, category: 1, rating: 1,
};

// ---------------------------------------------------------------------------
// Media resolution + product mapping (moved from simple-products.js,
// output shape preserved; `management` blob no longer returned in listings).
// ---------------------------------------------------------------------------

async function resolveCategoryId(categoryValue) {
  const raw = String(categoryValue ?? '').trim();
  if (!raw) return '';
  if (mongoose.Types.ObjectId.isValid(raw)) return raw;
  const rx = new RegExp(`^${String(raw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const doc = await CategoryModel.findOne({ $or: [{ name: rx }, { slug: rx }] }).lean();
  return doc ? String(doc._id) : '';
}

async function buildMediaMap(req, products) {
  const urls = [];
  for (const p of products || []) {
    const mgmt = p && p.management;
    const images = mgmt && mgmt.media && Array.isArray(mgmt.media.images) ? mgmt.media.images : [];
    for (const img of images) {
      const u = String((img && img.url) || '').trim();
      if (u) urls.push(u);
    }
    const primary = String((p && p.image) || '').trim();
    if (primary) urls.push(primary);
    for (const g of Array.isArray(p && p.galleryImages) ? p.galleryImages : []) {
      const gs = String(g || '').trim();
      if (gs) urls.push(gs);
    }
  }
  const mediaList = await resolveMediaForValues(req, urls);
  const map = new Map();
  urls.forEach((u, i) => {
    if (mediaList[i] && mediaList[i].url) map.set(u, mediaList[i]);
  });
  return map;
}

function pickSizeValues(management) {
  const sets = management && management.attributes && Array.isArray(management.attributes.sets)
    ? management.attributes.sets
    : [];
  const matches = sets.filter((s) => {
    const name = typeof (s && s.name) === 'string' ? String(s.name).toLowerCase() : '';
    return !!name && name.includes('size') && !name.includes('guide');
  });
  const vals = matches.flatMap((m) => (Array.isArray(m && m.values) ? m.values : []));
  const seen = new Set();
  return vals.map((v) => String(v)).map((v) => v.trim()).filter((v) => v.length > 0)
    .filter((v) => { const k = v.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

function pickAttributeValues(management, needle) {
  const sets = management && management.attributes && Array.isArray(management.attributes.sets)
    ? management.attributes.sets
    : [];
  const lower = String(needle || '').toLowerCase();
  const matches = sets.filter((s) => typeof (s && s.name) === 'string' && String(s.name).toLowerCase().includes(lower));
  return matches.flatMap((m) => (Array.isArray(m && m.values) ? m.values : []))
    .map((v) => String(v)).map((v) => v.trim()).filter((v) => v.length > 0);
}

function mapProduct(req, p, mediaMap) {
  const management = p && p.management ? p.management : null;
  const canonical = normalizeProduct(p);
  const shipping = management && management.shipping ? management.shipping : null;

  const rawMediaImages = Array.isArray(management && management.media && management.media.images)
    ? management.media.images
    : [];
  const mediaThumbId = management && management.media ? management.media.thumbnailId : null;
  const mediaThumb = mediaThumbId ? rawMediaImages.find((i) => i && i.id === mediaThumbId) : null;
  const mediaPrimary = String((mediaThumb && mediaThumb.url) || (rawMediaImages[0] && rawMediaImages[0].url) || '').trim();
  const mediaGallery = rawMediaImages.map((i) => String((i && i.url) || '').trim()).filter((u) => u.length > 0);

  const mediaEntries = rawMediaImages
    .map((img) => {
      const raw = String((img && img.url) || '').trim();
      const m = raw && mediaMap ? mediaMap.get(raw) : null;
      return {
        id: img && img.id ? String(img.id) : '',
        alt: String((img && img.alt) || '').trim(),
        url: m ? m.url : resolveAssetUrl(req, raw),
        variants: m ? m.variants : null,
        width: m ? m.width : null,
        height: m ? m.height : null,
      };
    })
    .filter((e) => e.url);

  const storedPrimary = canonical.image || mediaPrimary;
  const resolvedPrimary = storedPrimary && mediaMap ? mediaMap.get(storedPrimary) : null;
  const image = resolvedPrimary ? resolvedPrimary.url : resolveAssetUrl(req, storedPrimary);
  const imageMedia = resolvedPrimary
    ? { url: resolvedPrimary.url, variants: resolvedPrimary.variants, width: resolvedPrimary.width, height: resolvedPrimary.height }
    : null;

  const gallerySources = (Array.isArray(p.galleryImages) && p.galleryImages.length ? p.galleryImages : mediaGallery);
  const galleryImages = gallerySources
    .map((img) => {
      const resolved = mediaMap ? mediaMap.get(String(img).trim()) : null;
      return resolved ? resolved.url : resolveAssetUrl(req, img);
    })
    .filter(Boolean);

  const derivedColors = pickAttributeValues(management, 'color');
  const generatedColorVariants = derivedColors.map((colorNameRaw) => {
    const colorName = String(colorNameRaw || '').trim();
    return { color: colorName.toLowerCase().replace(/\s+/g, '-'), colorName, colorCode: '', images: [] };
  });
  const storedVariants = Array.isArray(p.colorVariants) && p.colorVariants.length ? p.colorVariants : null;
  const mgmtVariants = management && Array.isArray(management.colorVariants) && management.colorVariants.length
    ? management.colorVariants
    : null;
  const hasAnyVariantImages = (variants) => Array.isArray(variants) && variants.some((v) => Array.isArray(v && v.images) && v.images.length > 0);
  const preferredVariants = hasAnyVariantImages(mgmtVariants)
    ? mgmtVariants
    : (hasAnyVariantImages(storedVariants) ? storedVariants : null);

  const colorVariants = (preferredVariants || mgmtVariants || storedVariants || generatedColorVariants)
    .map((v) => {
      const images = Array.isArray(v && v.images) ? v.images.map((img) => resolveAssetUrl(req, img)).filter(Boolean) : [];
      const sku = typeof (v && v.sku) === 'string' ? v.sku.trim() : '';
      return {
        ...v,
        images,
        sku: sku || undefined,
        price: Number.isFinite(Number(v && v.price)) ? Number(v.price) : (v && v.price),
        stock: Number.isFinite(Number(v && v.stock)) ? Number(v.stock) : (v && v.stock),
      };
    });

  const sizeGuideValues = pickAttributeValues(management, 'size guide');
  const sizeGuideKey = sizeGuideValues.length ? String(sizeGuideValues[0]) : '';
  const rawAttributes = management && management.attributes ? management.attributes : {};

  return {
    _id: canonical.id,
    id: canonical.id,
    slug: canonical.slug,
    visibility: canonical.visibility,
    name: canonical.name,
    sku: canonical.sku,
    price: canonical.price,
    originalPrice: canonical.originalPrice,
    stock: canonical.stock,
    status: canonical.status,
    brand: canonical.brand,
    image,
    imageMedia,
    galleryImages,
    category: canonical.category,
    description: canonical.description,
    descriptionHtml: canonical.descriptionHtml,
    media: mediaEntries,
    featured: canonical.featured,
    badge: canonical.badge,
    rating: canonical.rating,
    reviews: canonical.reviewCount,
    createdAt: canonical.createdAt,
    updatedAt: canonical.updatedAt,
    freeShipping: canonical.freeShipping,
    codAvailable: canonical.codAvailable,
    codCharge: canonical.codCharge,
    shippingCharge: canonical.shippingCharge,
    weight: canonical.weight,
    dimensions: canonical.dimensions,
    sizes: canonical.sizes,
    colors: canonical.colors,
    sizeGuide: sizeGuideValues,
    sizeGuideKey,
    sizeGuideImageUrl: resolveAssetUrl(req, rawAttributes.sizeGuideImageUrl),
    colorVariants,
    saleEnabled: canonical.saleEnabled,
    saleDiscount: canonical.saleDiscount,
    saleStartDate: canonical.saleStartDate,
    saleEndDate: canonical.saleEndDate,
    salePageEnabled: canonical.salePageEnabled,
    salePageBannerText: canonical.salePageBannerText,
    tags: canonical.tags,
    metaTitle: canonical.metaTitle,
    metaDescription: canonical.metaDescription,
    weightKg: toFiniteNumber(shipping && shipping.weightKg, canonical.weight),
  };
}

async function mapProducts(req, products) {
  const list = Array.isArray(products) ? products : [];
  const mediaMap = await buildMediaMap(req, list);
  return list.map((p) => mapProduct(req, p, mediaMap));
}

// ---------------------------------------------------------------------------
// Listing projection — never transfer the full document (no reviews/questions/
// management blobs, no unrelated fields).
// ---------------------------------------------------------------------------

const LISTING_PROJECTION = {
  _id: 1, slug: 1, name: 1, sku: 1, price: 1, originalPrice: 1, stock: 1, status: 1, visibility: 1,
  image: 1, galleryImages: 1, category: 1, categoryId: 1, subCategoryId: 1, description: 1,
  featured: 1, badge: 1, rating: 1, createdAt: 1, updatedAt: 1, brand: 1,
  freeShipping: 1, codAvailable: 1, codCharge: 1, shippingCharge: 1, weight: 1, dimensions: 1,
  sizes: 1, colors: 1, colorVariants: 1, tags: 1, saleEnabled: 1, saleDiscount: 1,
  saleStartDate: 1, saleEndDate: 1, salePageEnabled: 1, salePageBannerText: 1,
  metaTitle: 1, metaDescription: 1, keyFeatures: 1,
  'management.basic': 1, 'management.pricing': 1, 'management.inventory': 1, 'management.media': 1,
  'management.colorVariants': 1, 'management.attributes': 1, 'management.shipping': 1,
  'management.marketing': 1, 'management.seo': 1,
};

// ---------------------------------------------------------------------------
// Sort whitelist — never accept arbitrary user-provided sort fields.
// ---------------------------------------------------------------------------

const SORT_WHITELIST = {
  price_asc: { price: 1, createdAt: -1 },
  price_desc: { price: -1, createdAt: -1 },
  name_asc: { name: 1, createdAt: -1 },
  name_desc: { name: -1, createdAt: -1 },
  rating_desc: { rating: -1, createdAt: -1 },
  newest: { createdAt: -1 },
  relevance: null, // handled by ranking when q present; falls back to newest
};

function resolveSort(sort) {
  if (sort && Object.prototype.hasOwnProperty.call(SORT_WHITELIST, sort)) return SORT_WHITELIST[sort];
  return SORT_WHITELIST.newest;
}

// ---------------------------------------------------------------------------
// Facet aggregation — one $facet pipeline, filter-aware.
// ---------------------------------------------------------------------------

function stripFacetFilter(filter, facetName) {
  const next = { ...filter };
  delete next.page;
  delete next.limit;
  if (facetName === 'brands') {
    delete next.brand;
    delete next['management.basic.brand'];
  } else if (facetName === 'colors') {
    delete next.colors;
  } else if (facetName === 'sizes') {
    delete next.sizes;
  } else if (facetName === 'price') {
    delete next.price;
  } else if (facetName === 'rating') {
    delete next.rating;
  } else if (facetName === 'stock') {
    delete next.stock;
  }
  return next;
}

async function computeFacets(baseFilter) {
  const db = mongoose.connection.db;
  // Each facet sub-pipeline starts with its OWN $match so a facet is computed
  // WITHIN the current search/category/other filters but WITHOUT its own filter
  // (classic facet behavior: seeing 'other brands' while a brand is selected).
  const facetPipeline = (name) => [
    { $match: stripFacetFilter(baseFilter, name) },
    { $project: { b: { $ifNull: ['$management.basic.brand', '$brand'] } } },
    { $match: { b: { $nin: ['', null] } } },
    { $group: { _id: '$b', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 20 },
  ];
  const pipeline = [
    {
      $facet: {
        brands: facetPipeline('brands'),
        colors: [
          { $match: stripFacetFilter(baseFilter, 'colors') },
          { $unwind: { path: '$colors', preserveNullAndEmptyArrays: false } },
          { $group: { _id: '$colors', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 20 },
        ],
        sizes: [
          { $match: stripFacetFilter(baseFilter, 'sizes') },
          { $unwind: { path: '$sizes', preserveNullAndEmptyArrays: false } },
          { $group: { _id: '$sizes', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 20 },
        ],
        priceBuckets: [
          { $match: stripFacetFilter(baseFilter, 'price') },
          {
            $bucket: {
              groupBy: '$price',
              boundaries: [0, 100, 250, 500, 1000, 2500, 5000],
              default: '5000+',
              output: { count: { $sum: 1 } },
            },
          },
        ],
        ratingBuckets: [
          { $match: stripFacetFilter(baseFilter, 'rating') },
          {
            $bucket: {
              groupBy: '$rating',
              boundaries: [1, 2, 3, 4, 5, 6],
              default: 'unrated',
              output: { count: { $sum: 1 } },
            },
          },
        ],
        availability: [
          { $match: stripFacetFilter(baseFilter, 'stock') },
          {
            $group: {
              _id: null,
              inStock: {
                $sum: {
                  $cond: {
                    if: { $gt: ['$stock', 0] },
                    then: 1,
                    else: 0,
                  },
                },
              },
              outOfStock: {
                $sum: {
                  $cond: {
                    if: { $lte: ['$stock', 0] },
                    then: 1,
                    else: 0,
                  },
                },
              },
            },
          },
        ],
        subcategories: [
          { $match: stripFacetFilter(baseFilter, 'subcategories') },
          { $project: { s: { $ifNull: ['$management.basic.subCategoryId', '$subCategoryId'] } } },
          { $match: { s: { $nin: ['', null] } } },
          { $group: { _id: '$s', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 20 },
        ],
      },
    },
  ];
  const [result] = await db.collection('products').aggregate(pipeline).toArray();
  const toValues = (rows) => (rows || []).map((r) => ({ value: String(r._id), count: r.count }));

  const availabilityResult = (result && result.availability && result.availability[0]) || {};
  const availabilityCounts = {
    inStock: Number(availabilityResult.inStock || 0),
    outOfStock: Number(availabilityResult.outOfStock || 0),
  };

  return {
    brands: toValues(result && result.brands),
    colors: toValues(result && result.colors),
    sizes: toValues(result && result.sizes),
    priceBuckets: ((result && result.priceBuckets) || []).map((r) => {
      if (r._id === '5000+') return { from: 5000, to: null, label: '₹5000+', count: r.count };
      const boundaries = [0, 100, 250, 500, 1000, 2500, 5000];
      const idx = boundaries.indexOf(Number(r._id));
      const to = idx >= 0 && idx < boundaries.length - 1 ? boundaries[idx + 1] : null;
      return { from: Number(r._id), to, label: to === null ? `₹${Number(r._id)}` : `₹${Number(r._id)}–₹${to}`, count: r.count };
    }),
    ratingBuckets: ((result && result.ratingBuckets) || []).map((r) => ({
      label: r._id === 'unrated' ? 'No ratings yet' : `${r._id}★ & up`,
      min: r._id === 'unrated' ? null : Number(r._id),
      count: r.count,
    })),
    availability: availabilityCounts,
    subcategories: toValues(result && result.subcategories),
  };
}

// ---------------------------------------------------------------------------
// Category counts — ONE aggregation (replaces the previous N+1 pattern).
// ---------------------------------------------------------------------------

async function computeCategoryCounts(mode) {
  const db = mongoose.connection.db;
  const base = publicBaseFilter(mode);
  // Collect DISTINCT product ids per category across all three legacy reference
  // shapes, then count unique products — a product referenced by both
  // `category` and `management.basic.categoryIds` counts ONCE per category.
  const pipeline = [
    { $match: base },
    {
      $facet: {
        top: [{ $group: { _id: '$category', ids: { $addToSet: '$_id' } } }],
        byCategoryIdField: [
          { $match: { categoryId: { $nin: ['', null] } } },
          { $group: { _id: '$categoryId', ids: { $addToSet: '$_id' } } },
        ],
        byIds: [
          { $unwind: { path: '$management.basic.categoryIds', preserveNullAndEmptyArrays: false } },
          { $group: { _id: '$management.basic.categoryIds', ids: { $addToSet: '$_id' } } },
        ],
        subs: [
          { $project: { s: { $ifNull: ['$management.basic.subCategoryId', '$subCategoryId'] } } },
          { $match: { s: { $nin: ['', null] } } },
          { $group: { _id: '$s', ids: { $addToSet: '$_id' } } },
        ],
      },
    },
  ];
  const [result] = await db.collection('products').aggregate(pipeline).toArray();
  const idsByCategory = new Map(); // categoryId -> Set(productId)
  const countBySub = new Map();
  const mergeIds = (rows) => {
    for (const r of rows || []) {
      if (r._id === null || r._id === undefined || r._id === '') continue;
      const key = String(r._id);
      if (!idsByCategory.has(key)) idsByCategory.set(key, new Set());
      for (const id of r.ids || []) idsByCategory.get(key).add(String(id));
    }
  };
  mergeIds(result && result.top);
  mergeIds(result && result.byCategoryIdField);
  mergeIds(result && result.byIds);
  for (const r of (result && result.subs) || []) {
    if (!r._id) continue;
    countBySub.set(String(r._id), (r.ids || []).length);
  }
  const countById = new Map();
  for (const [key, ids] of idsByCategory) countById.set(key, ids.size);
  return { countById, countBySub };
}

// ---------------------------------------------------------------------------
// Main entry: parse params → query → map → (facets) → response
// ---------------------------------------------------------------------------

function buildQueryFilter(params) {
  const { mode, category, subCategoryId, q, minPrice, maxPrice, inStock, outOfStock, freeShipping, onSale, sizes, colors, brands, rating, featured } = params;
  const filter = publicBaseFilter(mode);

  if (category) {
    const or = [{ category }];
    if (mongoose.Types.ObjectId.isValid(category)) {
      or.push({ categoryId: category });
      or.push({ 'management.basic.categoryIds': category });
    } else {
      or.push({ category: new RegExp(`^${String(category).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
    }
    filter.$and = Array.isArray(filter.$and) ? filter.$and : [];
    filter.$and.push({ $or: or });
  }

  if (subCategoryId) {
    filter.$and = Array.isArray(filter.$and) ? filter.$and : [];
    filter.$and.push({ $or: [{ subCategoryId }, { 'management.basic.subCategoryId': subCategoryId }] });
  }

  if (minPrice !== undefined || maxPrice !== undefined) {
    filter.price = {};
    if (minPrice !== undefined) filter.price.$gte = minPrice;
    if (maxPrice !== undefined) filter.price.$lte = maxPrice;
  }

  if (inStock) filter.stock = { $gt: 0 };
  if (outOfStock) filter.stock = { $lte: 0 };
  if (freeShipping) filter.freeShipping = true;
  if (onSale) { filter.saleEnabled = true; filter.saleDiscount = { $gt: 0 }; }
  if (featured) filter.featured = true;
  if (rating !== undefined && Number.isFinite(Number(rating)) && Number(rating) > 0) {
    filter.rating = { $gte: Number(rating) };
  }
  if (sizes && sizes.length) filter.sizes = { $in: sizes };
  if (colors && colors.length) filter.colors = { $in: colors };
  if (brands && brands.length) filter.brand = { $in: brands };

  return filter;
}

/**
 * queryCatalog — the single catalog/search entry point.
 * Returns { items, pagination, facets?, search? } (array-form preserved via opts.arrayMode).
 */
async function queryCatalog({ req, mode = 'public', category, subCategoryId, q, minPrice, maxPrice, inStock, outOfStock, freeShipping, onSale, sizes, colors, brands, rating, featured, sort, order, page, limit, wantFacets = false, fields }) {
  const started = Date.now();
  let total = 0;
  let searchInfo = null;
  const resolvedCategoryId = category ? await resolveCategoryId(category) : '';

  const params = {
    mode, category: resolvedCategoryId || category, subCategoryId,
    q, minPrice, maxPrice, inStock, outOfStock, freeShipping, onSale, sizes, colors, brands, rating, featured,
  };
  const filter = buildQueryFilter(params);
  const sortSpec = resolveSort(sort);

  const shouldPaginate = page !== undefined || limit !== undefined;
  const safePage = Math.max(1, page ?? 1);
  const safeLimit = Math.min(100, Math.max(1, limit ?? 24));
  const skip = (safePage - 1) * safeLimit;

  const db = mongoose.connection.db;
  const products = db.collection('products');

  // Use basic projection for home page sliders to reduce payload
  const projection = fields === 'basic' ? BASIC_PROJECTION : LISTING_PROJECTION;

  // Search path: build the search filter and rank by relevance.
  if (q) {
    const { filter: searchFilter, tokens, full, substringUsed } = buildSearchFilter(q, filter, { minChars: minCharsSetting() });
    const ranked = await products
      .find(searchFilter)
      .project(projection)
      .sort({ createdAt: -1 })
      .limit(candidateCap())
      .toArray();
    const scored = rankProducts(ranked, tokens, full);
    total = scored.length;
    searchInfo = { query: full, tookMs: Date.now() - started, substringUsed, rankedCount: total };
    const slice = shouldPaginate ? scored.slice(skip, skip + safeLimit) : scored;
    const docs = slice.map((s) => s.p);
    if (shouldPaginate) {
      const totalPages = Math.max(1, Math.ceil(total / safeLimit));
      return await finish({ req, docs, total, totalPages, page: safePage, limit: safeLimit, facets: wantFacets ? await computeFacets(filter) : null, searchInfo });
    }
    const items = await mapProducts(req, docs);
    return items;
  }

  // Standard listing path.
  const cursor = products.find(filter).project(projection);
  if (sortSpec) cursor.sort(sortSpec);
  const run = async () => {
    if (shouldPaginate) {
      const [totalItems, docsList] = await Promise.all([
        products.countDocuments(filter),
        cursor.skip(skip).limit(safeLimit).toArray(),
      ]);
      const totalPages = Math.max(1, Math.ceil(Number(totalItems || 0) / safeLimit));
      return { docs: docsList, total: totalItems, totalPages };
    }
    const docsList = await cursor.toArray();
    return { docs: docsList, total: docsList.length, totalPages: 1 };
  };
  const { docs: docsList, total: totalItems, totalPages } = await run();
  if (!shouldPaginate) {
    // Backward-compatible non-paginated form: plain array of mapped products.
    const items = await mapProducts(req, docsList);
    return items;
  }
  return await finish({ req, docs: docsList, total: totalItems, totalPages, page: safePage, limit: safeLimit, facets: wantFacets ? await computeFacets(filter) : null, searchInfo });
}

async function finish({ req, docs, total, totalPages, page, limit, facets, searchInfo }) {
  const items = await mapProducts(req, docs);
  const payload = {
    items,
    page,
    limit,
    total,
    totalPages,
    totalItems: total,
  };
  if (facets) payload.facets = facets;
  if (searchInfo) payload.search = searchInfo;
  return payload;
}

/**
 * Public listing with caching — used by the storefront routes.
 * Only safe, non-user-specific public responses are cached.
 */
async function listPublic(req, params) {
  if (params.mode !== 'public') return queryCatalog({ req, ...params });
  const host = req && req.get ? req.get('host') : 'local';
  const key = `catalog|${host}|${JSON.stringify({
    mode: params.mode, category: params.category, subCategoryId: params.subCategoryId,
    q: params.q, minPrice: params.minPrice, maxPrice: params.maxPrice, inStock: params.inStock, outOfStock: params.outOfStock,
    freeShipping: params.freeShipping, onSale: params.onSale, sizes: params.sizes, colors: params.colors,
    brands: params.brands, rating: params.rating, featured: params.featured, sort: params.sort,
    page: params.page, limit: params.limit, facets: params.wantFacets,
  })}`;
  const result = await cacheService.getOrSet(key, () => queryCatalog({ req, ...params }));
  return result.value;
}

// ---------------------------------------------------------------------------
// Suggestions — lightweight category/brand suggestions for full search.
// ---------------------------------------------------------------------------

async function suggestForQuery(q, { limit = 3 } = {}) {
  const query = String(q || '').trim().toLowerCase();
  const out = { categories: [], brands: [] };
  if (!query) return out;
  const rx = new RegExp(`^${String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  const rxAny = new RegExp(String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  try {
    const cats = await CategoryModel.find({
      $or: [{ name: rx }, { name: rxAny }],
      active: true,
    })
      .select('name parentId slug')
      .sort({ order: 1 })
      .limit(limit)
      .lean();
    out.categories = cats.map((c) => ({
      id: String(c._id),
      name: c.name,
      parentId: c.parentId ? String(c.parentId) : null,
    }));
  } catch (e) {
    // suggestions are best-effort; never fail the search for them
  }

  try {
    const db = mongoose.connection.db;
    const rows = await db.collection('products')
      .aggregate([
        { $project: { b: { $ifNull: ['$management.basic.brand', '$brand'] } } },
        { $match: { b: { $nin: ['', null] } } },
        { $group: { _id: '$b' } },
        { $sort: { _id: 1 } },
        { $limit: 50 },
      ])
      .toArray();
    out.brands = rows
      .map((r) => String(r._id))
      .filter((b) => b.toLowerCase().startsWith(query) || b.toLowerCase().includes(query))
      .slice(0, 5);
  } catch (e) {
    // best-effort
  }
  return out;
}

async function fetchPopularProducts(req, { limit = 60 } = {}) {
  const db = mongoose.connection.db;
  const paidStatuses = ['paid', 'shipped', 'delivered'];
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 60));

  const pipeline = [
    {
      $match: { 
        status: { $in: paidStatuses },
        'items.productId': { $ne: null, $ne: '' }
      }
    },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.productId',
        totalSold: { $sum: '$items.quantity' }
      }
    },
    { $sort: { totalSold: -1 } },
    { $limit: safeLimit }
  ];
  
  const results = await db.collection('orders').aggregate(pipeline).toArray();
  const productIds = results.map(r => r._id);
  
  if (productIds.length === 0) return [];
  
  // Handle both string IDs and ObjectIds for flexible matching
  const objectIds = productIds
    .filter(id => mongoose.Types.ObjectId.isValid(String(id)))
    .map(id => new mongoose.Types.ObjectId(String(id)));
  const stringIds = productIds
    .filter(id => !mongoose.Types.ObjectId.isValid(String(id)))
    .map(id => String(id));
  
  const idConditions = [];
  if (objectIds.length > 0) {
    idConditions.push({ _id: { $in: objectIds } });
  }
  if (stringIds.length > 0) {
    idConditions.push({ _id: { $in: stringIds } });
  }
  
  const productFilter = idConditions.length > 0 
    ? { $or: idConditions, status: { $in: ['active', 'published'] } }
    : { status: { $in: ['active', 'published'] } };
  
  const products = await db.collection('products')
    .find(productFilter)
    .project(LISTING_PROJECTION)
    .toArray();
  
  // Create a map of productId -> totalSold for sorting
  const salesMap = new Map(results.map(r => [String(r._id), r.totalSold]));
  
  // Sort products by sales count, with createdAt as tiebreaker
  const sortedProducts = products.sort((a, b) => {
    const salesA = salesMap.get(String(a._id)) || 0;
    const salesB = salesMap.get(String(b._id)) || 0;
    if (salesB !== salesA) {
      return salesB - salesA;
    }
    // Tiebreaker: newer products first
    const dateA = new Date(a.createdAt || 0).getTime();
    const dateB = new Date(b.createdAt || 0).getTime();
    return dateB - dateA;
  });
  
  return await mapProducts(req, sortedProducts);
}

async function getPopularProducts(req, { limit = 60 } = {}) {
  const host = req && req.get ? req.get('host') : 'local';
  const key = `popular|${host}|${limit}`;
  const result = await cacheService.getOrSet(key, () => fetchPopularProducts(req, { limit }), 900); // 15 min cache
  return result.value;
}

module.exports = {
  queryCatalog,
  listPublic,
  mapProduct,
  mapProducts,
  buildMediaMap,
  computeFacets,
  computeCategoryCounts,
  buildQueryFilter,
  publicBaseFilter,
  resolveCategoryId,
  suggestForQuery,
  getPopularProducts,
  LISTING_PROJECTION,
  BASIC_PROJECTION,
  SEARCH_SUGGEST_PROJECTION,
  SORT_WHITELIST,
  parseIntQuery,
  parseCsvQuery,
  toBool,
  toFiniteNumber,
  toTrimmedString,
};
