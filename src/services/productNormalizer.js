/**
 * productNormalizer.js
 *
 * The ONE canonical normalization layer for product documents.
 *
 * Product documents in MongoDB carry BOTH legacy top-level fields (name, price,
 * stock, category, brand, sizes, colors, ...) AND a schema-free `management`
 * Mixed document (basic, pricing, inventory, media, attributes, seo, shipping,
 * marketing, salePage, ...).
 *
 * Every route/service must resolve authoritative values through this module so
 * that `stock` vs `inventory.stockQuantity` (and every other dual field) is
 * decided by exactly ONE rule. MongoDB remains the persisted source of truth;
 * this module produces the canonical in-memory domain object.
 */

const COLOR_FAMILIES = [
  { family: 'black', keys: ['black', 'ebony', 'charcoal', 'graphite', 'jet'] },
  { family: 'white', keys: ['white', 'ivory', 'off-white', 'cream', 'milky'] },
  { family: 'gray', keys: ['gray', 'grey', 'silver', 'graphite grey'] },
  { family: 'brown', keys: ['brown', 'tan', 'beige', 'chocolate', 'coffee', 'khaki', 'camel', 'taupe'] },
  { family: 'red', keys: ['red', 'maroon', 'crimson', 'burgundy', 'scarlet', 'ruby'] },
  { family: 'pink', keys: ['pink', 'rose', 'salmon', 'magenta', 'fuchsia', 'blush'] },
  { family: 'orange', keys: ['orange', 'peach', 'apricot', 'coral', 'amber'] },
  { family: 'yellow', keys: ['yellow', 'golden', 'mustard', 'lemon', 'gold'] },
  { family: 'green', keys: ['green', 'olive', 'emerald', 'mint', 'teal', 'bottle green', 'lime', 'sage'] },
  { family: 'blue', keys: ['blue', 'navy', 'sky', 'indigo', 'royal', 'azure', 'turquoise', 'aqua', 'cyan'] },
  { family: 'purple', keys: ['purple', 'violet', 'lavender', 'lilac', 'plum', 'mauve'] },
  { family: 'multicolor', keys: ['multicolor', 'multicolour', 'multi', 'mixed', 'colorful', 'colourful', 'printed'] },
];

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeText(value) {
  // Search/filter normalization: lowercase, collapse whitespace, drop punctuation.
  return toTrimmedString(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeColor(displayColor) {
  const raw = toTrimmedString(displayColor);
  if (!raw) return { displayColor: '', normalizedColor: '', colorFamily: 'other' };
  const normalizedColor = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const hit = COLOR_FAMILIES.find((f) => f.keys.some((k) => raw.toLowerCase().includes(k)));
  return { displayColor: raw, normalizedColor, colorFamily: hit ? hit.family : 'other' };
}

function normalizeAttributes(management) {
  const sets = management && management.attributes && Array.isArray(management.attributes.sets)
    ? management.attributes.sets
    : [];
  return sets.map((set) => {
    const name = toTrimmedString(set && set.name);
    const values = Array.isArray(set && set.values) ? set.values.map((v) => toTrimmedString(v)).filter(Boolean) : [];
    return {
      id: set && set.id ? String(set.id) : '',
      name,
      normalizedName: normalizeText(name),
      values,
      normalizedValues: values.map((v) => normalizeText(v)).filter(Boolean),
      filterable: !!(set && set.filterable),
      searchable: !(set && set.searchable === false),
      facetable: !!(set && set.facetable),
      sortable: !!(set && set.sortable),
    };
  }).filter((a) => a.name);
}

function pickAttributeValues(management, needle) {
  const sets = management && management.attributes && Array.isArray(management.attributes.sets)
    ? management.attributes.sets
    : [];
  const lower = String(needle || '').toLowerCase();
  const matches = sets.filter((s) => toTrimmedString(s && s.name).toLowerCase().includes(lower));
  const vals = matches.flatMap((m) => (Array.isArray(m && m.values) ? m.values : []));
  const seen = new Set();
  return vals
    .map((v) => toTrimmedString(v))
    .filter((v) => v.length > 0)
    .filter((v) => {
      const key = v.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function pickSizeValues(management) {
  const sets = management && management.attributes && Array.isArray(management.attributes.sets)
    ? management.attributes.sets
    : [];
  return pickAttributeValues(management, 'size').filter((v) => !v.toLowerCase().includes('guide'));
}

/**
 * Resolve one canonical product object from a raw MongoDB document.
 * All rules below are the single authoritative resolution order.
 */
function normalizeProduct(doc) {
  const management = (doc && doc.management && typeof doc.management === 'object') ? doc.management : {};
  const basic = management.basic || {};
  const pricing = management.pricing || {};
  const inventory = management.inventory || {};
  const marketing = management.marketing || {};
  const seo = management.seo || {};
  const shipping = management.shipping || {};
  const salePage = management.salePage || {};

  const price = toFiniteNumber(
    pricing.sellingPrice ?? pricing.selling_price ?? doc.price,
    toFiniteNumber(doc.price, 0),
  );
  const originalPrice = toFiniteNumber(
    pricing.originalPrice ?? pricing.compareAtPrice ?? doc.originalPrice,
    toFiniteNumber(doc.originalPrice, 0),
  );
  const stock = toFiniteNumber(
    inventory.stockQuantity ?? inventory.stock_quantity ?? doc.stock,
    toFiniteNumber(doc.stock, 0),
  );

  const rawStatus = toTrimmedString(basic.status) || toTrimmedString(doc.status) || 'draft';
  const status = rawStatus === 'archived' ? 'inactive' : rawStatus;

  const visibility = toTrimmedString(basic.visibility) || (doc.visibility == null ? 'public' : toTrimmedString(doc.visibility)) || 'public';

  const categoryIds = Array.isArray(basic.categoryIds) ? basic.categoryIds.map((c) => toTrimmedString(c)).filter(Boolean) : [];
  const categoryId = toTrimmedString(doc.categoryId) || categoryIds[0] || toTrimmedString(doc.category) || '';
  const subCategoryId = toTrimmedString(basic.subCategoryId) || toTrimmedString(doc.subCategoryId) || '';

  const attributeSets = normalizeAttributes(management);

  const storedSizes = Array.isArray(doc.sizes) && doc.sizes.length ? doc.sizes.map((s) => toTrimmedString(s)).filter(Boolean) : [];
  const storedColors = Array.isArray(doc.colors) && doc.colors.length ? doc.colors.map((c) => toTrimmedString(c)).filter(Boolean) : [];
  const sizes = storedSizes.length ? storedSizes : pickSizeValues(management);
  const colors = storedColors.length ? storedColors : pickAttributeValues(management, 'color');

  const freeShipping = typeof doc.freeShipping === 'boolean'
    ? doc.freeShipping
    : Boolean(shipping.freeShipping);
  const codAvailable = typeof doc.codAvailable === 'boolean'
    ? doc.codAvailable
    : Boolean(shipping.codAvailable);
  const codCharge = toFiniteNumber(doc.codCharge ?? shipping.codCharge, 0);
  const shippingCharge = toFiniteNumber(doc.shippingCharge ?? shipping.shippingCharge, 0);
  const weight = toFiniteNumber(doc.weight ?? shipping.weightKg, 0);
  const dimensions = (doc.dimensions && typeof doc.dimensions === 'object')
    ? doc.dimensions
    : (shipping.dimensionsCm && typeof shipping.dimensionsCm === 'object' ? shipping.dimensionsCm : { length: 0, width: 0, height: 0 });

  const name = toTrimmedString(basic.name) || toTrimmedString(doc.name) || '';
  const sku = toTrimmedString(inventory.sku) || toTrimmedString(doc.sku) || '';
  const brand = toTrimmedString(basic.brand) || toTrimmedString(doc.brand) || '';
  const description = toTrimmedString(basic.shortDescription) || toTrimmedString(doc.description) || '';
  const descriptionHtml = typeof basic.descriptionHtml === 'string' ? basic.descriptionHtml : '';

  const featured = typeof marketing.featured === 'boolean' ? marketing.featured : Boolean(doc.featured);
  const badge = toTrimmedString(marketing.badge) || toTrimmedString(doc.badge) || '';

  const salePageEnabled = typeof salePage.enabled === 'boolean'
    ? salePage.enabled
    : Boolean(doc.salePageEnabled);
  const salePageBannerText = toTrimmedString(salePage.bannerText) || toTrimmedString(doc.salePageBannerText) || '';

  return {
    id: String(doc._id || ''),
    slug: toTrimmedString(doc.slug),
    sku,
    name,
    brand,
    visibility,
    status,
    price,
    originalPrice,
    stock,
    category: toTrimmedString(doc.category),
    categoryId,
    subCategoryId,
    description,
    descriptionHtml,
    featured,
    badge,
    freeShipping,
    codAvailable,
    codCharge,
    shippingCharge,
    weight,
    dimensions,
    sizes,
    colors,
    saleEnabled: Boolean(doc.saleEnabled),
    saleDiscount: toFiniteNumber(doc.saleDiscount, 0),
    saleStartDate: toTrimmedString(doc.saleStartDate),
    saleEndDate: toTrimmedString(doc.saleEndDate),
    salePageEnabled,
    salePageBannerText,
    rating: toFiniteNumber(doc.rating, 0),
    tags: Array.isArray(doc.tags) ? doc.tags.map((t) => toTrimmedString(t)).filter(Boolean) : [],
    keyFeatures: Array.isArray(doc.keyFeatures) ? doc.keyFeatures : [],
    metaTitle: toTrimmedString(seo.metaTitle) || toTrimmedString(doc.metaTitle) || '',
    metaDescription: toTrimmedString(seo.metaDescription) || toTrimmedString(doc.metaDescription) || '',
    image: toTrimmedString(doc.image),
    galleryImages: Array.isArray(doc.galleryImages) ? doc.galleryImages.map((u) => toTrimmedString(u)).filter(Boolean) : [],
    colorVariants: Array.isArray(doc.colorVariants) ? doc.colorVariants : [],
    attributeSets,
    normalizedName: normalizeText(name),
    normalizedBrand: normalizeText(brand),
    normalizedColors: colors.map((c) => normalizeColor(c).normalizedColor).filter(Boolean),
    colorFamilies: colors.map((c) => normalizeColor(c).colorFamily).filter((f) => f !== 'other'),
    reviewCount: Array.isArray(doc.reviews) ? doc.reviews.length : 0,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
    rawManagement: management,
  };
}

/**
 * Searchable projection — the optimized representation used for discovery.
 * The products collection remains authoritative; this projection is derived,
 * never stored as a competing source of truth.
 */
function buildSearchProjection(doc) {
  const p = normalizeProduct(doc);
  return {
    productId: p.id,
    slug: p.slug,
    name: p.name,
    normalizedName: p.normalizedName,
    brand: p.brand,
    normalizedBrand: p.normalizedBrand,
    category: p.category,
    categoryId: p.categoryId,
    subCategoryId: p.subCategoryId,
    searchableTags: p.tags,
    searchableAttributes: p.attributeSets.flatMap((a) => a.normalizedValues),
    normalizedColors: p.normalizedColors,
    sizes: p.sizes,
    price: p.price,
    rating: p.rating,
    reviewCount: p.reviewCount,
    stockAvailability: p.stock > 0 ? 'in_stock' : 'out_of_stock',
    stock: p.stock,
    featured: p.featured,
    saleEnabled: p.saleEnabled && p.saleDiscount > 0,
    createdAt: p.createdAt,
  };
}

/**
 * Synchronization hook. For the current Mongo provider the projection is
 * derived at query time, so this validates the projection builds and returns
 * it. When Atlas Search arrives, this same function can write the projection
 * into the index (synchronously today, async later).
 */
function syncSearchProjection(doc) {
  return buildSearchProjection(doc);
}

module.exports = {
  normalizeProduct,
  buildSearchProjection,
  syncSearchProjection,
  normalizeText,
  normalizeColor,
  normalizeAttributes,
  pickAttributeValues,
  pickSizeValues,
  toFiniteNumber,
  toTrimmedString,
};
