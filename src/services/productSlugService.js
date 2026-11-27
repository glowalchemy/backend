/**
 * productSlugService.js
 *
 * THE single source of truth for public product URL slugs.
 *
 * Rules enforced here (never trust frontend validation):
 *  - Automatic mode: slug = first three meaningful normalized words of the
 *    product name (fewer when the name has fewer words). No random suffixes.
 *  - Custom mode: admin-supplied slug, same format rules, any word count.
 *  - Globally unique across `products.slug` AND `product_slug_history.slug`
 *    (historical slugs are reserved forever so old URLs keep redirecting and
 *    are never reassigned to unrelated products).
 *  - Reserved application routes can never become product slugs.
 *
 * All functions take the raw MongoDB database handle (`mongoose.connection.db`)
 * so they work identically inside routes and CLI scripts.
 */

const SLUG_MAX_LENGTH = 80;
const SLUG_DEFAULT_WORDS = 3;
const SLUG_FORMAT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const HISTORY_COLLECTION = 'product_slug_history';

// ---------------------------------------------------------------------------
// Reserved slug registry
//
// Product URLs are root-level (`glowalchemycare.com/<slug>`), so every
// first-segment route in the customer SPA, every backend namespace reachable
// through the same host, and every static asset directory is reserved.
// Keep this in sync with frontend/src/App.jsx routes.
// ---------------------------------------------------------------------------
const RESERVED_SLUGS = new Set([
  // Customer SPA static routes (frontend/src/App.jsx)
  'product', 'productlisting', 'policies', 'privacy-policy', 'privacy',
  'terms-of-service', 'terms', 'terms-and-conditions', 'shipping-policy',
  'contact', 'about', 'help-center', 'help', 'order-tracking', 'track-order',
  'orders', 'order', 'login', 'register', 'signup', 'signin', 'sign-in',
  'forgot-password', 'reset-password', 'logout', 'account', 'profile',
  'cart', 'checkout', 'payment', 'summary', 'wishlist', 'search', 'blog',
  'company-profile', 'manufacturing-capabilities', 'services',
  'private-labeling', 'third-party-manufacturing', 'contract-manufacturing',
  'category', 'categories', 'products', 'shop', 'home', 'page', 'pages',
  'faq', 'faqs', 'return-policy', 'refund-policy', 'cancellation-policy',
  'admin', 'dashboard', 'settings', 'sitemap', 'feed',
  // Backend / API namespaces (reachable on the same host via /api or root)
  'api', 'uploads', 'socket.io', 'feed.xml', 'sitemap.xml', 'robots.txt',
  'manifest.json', 'favicon.ico',
  // Static asset directories (frontend/public + Vite build output)
  'assets', 'static', 'images', 'img', 'css', 'js', 'fonts', 'media',
  'videos', 'download', 'downloads',
]);

// Common non-Latin transliterations. NFKD + diacritic stripping already covers
// Latin-script accents; this map covers Cyrillic/Greek/etc. characters that
// would otherwise be dropped entirely.
const TRANSLITERATION = {
  // Cyrillic (Russian and related)
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e',
  'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
  'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
  'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch',
  'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
  'є': 'ye', 'і': 'i', 'ї': 'yi', 'ґ': 'g',
  // Greek
  'α': 'a', 'β': 'b', 'γ': 'g', 'δ': 'd', 'ε': 'e', 'ζ': 'z', 'η': 'i',
  'θ': 'th', 'ι': 'i', 'κ': 'k', 'λ': 'l', 'μ': 'm', 'ν': 'n', 'ξ': 'x',
  'ο': 'o', 'π': 'p', 'ρ': 'r', 'σ': 's', 'τ': 't', 'υ': 'y', 'φ': 'f',
  'χ': 'ch', 'ψ': 'ps', 'ω': 'o',
  // Latin Extended chars NFKD does not fully decompose
  'ą': 'a', 'ę': 'e', 'ś': 's', 'ć': 'c', 'ż': 'z', 'ź': 'z', 'ł': 'l',
  'ń': 'n', 'č': 'c', 'š': 's', 'ž': 'z', 'đ': 'd', 'ð': 'd', 'þ': 'th',
  'œ': 'oe', 'æ': 'ae', 'ø': 'o', 'å': 'a',
};

class SlugError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'SlugError';
    this.code = code;
    this.statusCode = 400;
    Object.assign(this, extra);
  }
}

/** Normalize one run of text into slug-safe word tokens. */
function normalizeSlugText(input) {
  if (typeof input !== 'string') return '';
  let s = input.normalize('NFKD');
  // Strip combining diacritical marks (é -> e, ü -> u, ...)
  s = s.replace(/[\u0300-\u036f]/g, '');
  s = s.toLowerCase();
  // Transliterate supported non-Latin characters
  s = s.replace(/[^\x00-\x7F]/g, (ch) => TRANSLITERATION[ch] ?? '');
  // Keep letters/digits, turn everything else into separators
  s = s.replace(/[^a-z0-9]+/g, ' ');
  return s.trim();
}

/** Meaningful word tokens of a product name, in order. */
function nameToWords(name) {
  const normalized = normalizeSlugText(name);
  if (!normalized) return [];
  return normalized.split(/\s+/).filter(Boolean);
}

function wordsToSlug(words) {
  return words.join('-').slice(0, SLUG_MAX_LENGTH).replace(/-+$/g, '');
}

/**
 * Automatic slug candidates from a product name.
 * Primary candidate = first SLUG_DEFAULT_WORDS meaningful words. Alternatives
 * extend the prefix, then try sliding windows so conflicts can be resolved
 * with meaningful product-name words only (never random suffixes).
 */
function generateSlugCandidates(name) {
  const words = nameToWords(name);
  if (!words.length) return [];

  const candidates = [];
  const seen = new Set();
  const push = (w) => {
    if (!w.length) return;
    const slug = wordsToSlug(w);
    if (!slug || seen.has(slug)) return;
    if (slug.length < 2) return; // single-char slugs are never useful
    seen.add(slug);
    candidates.push(slug);
  };

  // 1) Prefixes of increasing length starting at word 0 (3,4,5,... words)
  for (let n = SLUG_DEFAULT_WORDS; n <= words.length; n++) {
    push(words.slice(0, n));
  }
  // 2) Sliding windows of the default size, then larger windows
  for (let size = SLUG_DEFAULT_WORDS; size <= Math.min(words.length, SLUG_DEFAULT_WORDS + 2); size++) {
    for (let start = 1; start + size <= words.length; start++) {
      push(words.slice(start, start + size));
    }
  }
  // 3) If the name is very short, fall back to whatever exists
  if (!candidates.length) push(words);

  return candidates.slice(0, 15);
}

/** Format + reserved-route validation. Returns null when valid. */
function validateSlugFormat(slug) {
  const s = String(slug ?? '').trim().toLowerCase();
  if (!s) {
    return new SlugError('SLUG_REQUIRED', 'Please enter a valid product URL slug.');
  }
  if (s.length > SLUG_MAX_LENGTH) {
    return new SlugError('SLUG_TOO_LONG', 'The product URL exceeds the allowed length.', { maxLength: SLUG_MAX_LENGTH });
  }
  if (!SLUG_FORMAT.test(s)) {
    return new SlugError(
      'SLUG_INVALID',
      'Use lowercase letters, numbers where meaningful, and hyphens only.',
    );
  }
  if (RESERVED_SLUGS.has(s)) {
    return new SlugError('SLUG_RESERVED', 'This URL is reserved for an existing website page.');
  }
  return null;
}

function isValidObjectIdString(id) {
  return /^[0-9a-fA-F]{24}$/.test(String(id ?? ''));
}

async function findSlugOwner(db, slug, excludeProductId) {
  const filter = { slug: String(slug) };
  if (excludeProductId && isValidObjectIdString(excludeProductId)) {
    const { ObjectId } = require('mongodb');
    filter._id = { $ne: new ObjectId(String(excludeProductId)) };
  }
  return db.collection('products').findOne(filter, { projection: { _id: 1, name: 1, slug: 1 } });
}

async function findSlugHistory(db, slug) {
  return db.collection(HISTORY_COLLECTION).findOne({ slug: String(slug) });
}

/**
 * Check whether a slug can be used.
 * Returns { available, code?, message?, ownerName? }.
 */
async function checkSlugAvailability(db, slug, excludeProductId) {
  const formatError = validateSlugFormat(slug);
  if (formatError) {
    return { available: false, code: formatError.code, message: formatError.message };
  }

  const normalized = String(slug).trim().toLowerCase();

  // Same product re-saving its own slug is always fine.
  if (excludeProductId && isValidObjectIdString(excludeProductId)) {
    const { ObjectId } = require('mongodb');
    const self = await db.collection('products').findOne(
      { _id: new ObjectId(String(excludeProductId)) },
      { projection: { slug: 1 } },
    );
    if (self && String(self.slug || '').toLowerCase() === normalized) {
      return { available: true, current: true };
    }
  }

  const owner = await findSlugOwner(db, normalized, excludeProductId);
  if (owner) {
    return {
      available: false,
      code: 'SLUG_ALREADY_EXISTS',
      message: 'This product URL is already in use. Choose a different slug.',
      ownerName: owner.name || '',
    };
  }

  const history = await findSlugHistory(db, normalized);
  if (history) {
    return {
      available: false,
      code: 'SLUG_ALREADY_EXISTS',
      message: 'This URL was used by a previous product address and is kept reserved for redirects. Choose a different slug.',
    };
  }

  return { available: true };
}

/**
 * Resolve the final slug for a product write.
 *
 * @param {object}  db               mongoose.connection.db
 * @param {string}  name             product name (auto mode)
 * @param {string}  requestedSlug    admin-entered slug (custom/explicit mode); '' = auto
 * @param {string}  mode             'auto' | 'custom' (informational)
 * @param {string}  excludeProductId ObjectId string when updating
 * @returns {Promise<{slug:string, mode:string, changed:boolean}>}
 * @throws {SlugError}
 */
async function resolveProductSlug({ db, name, requestedSlug, mode = 'auto', excludeProductId }) {
  const requested = String(requestedSlug ?? '').trim().toLowerCase();

  if (requested) {
    const availability = await checkSlugAvailability(db, requested, excludeProductId);
    if (!availability.available) {
      throw new SlugError(availability.code || 'SLUG_INVALID', availability.message || 'Invalid slug', {
        ownerName: availability.ownerName,
      });
    }
    return { slug: requested, mode: 'custom', changed: true };
  }

  // Automatic mode — walk meaningful candidates until one is free.
  const candidates = generateSlugCandidates(name);
  if (!candidates.length) {
    throw new SlugError('SLUG_REQUIRED', 'Please enter a valid product URL slug.');
  }

  const tried = [];
  for (const candidate of candidates) {
    const availability = await checkSlugAvailability(db, candidate, excludeProductId);
    if (availability.available) {
      return { slug: candidate, mode: 'auto', changed: true };
    }
    tried.push(candidate);
    if (tried.length >= 8) break;
  }

  throw new SlugError(
    'SLUG_ALREADY_EXISTS',
    'This product URL is already in use. Choose a different slug.',
    { suggestions: candidates.slice(0, 8) },
  );
}

/**
 * Persist a slug change: archive the old slug into the redirect registry and
 * collapse redirect chains (any history entry pointing at the old slug now
 * points at the new one, so old -> old2 -> new chains become old -> new).
 */
async function recordSlugChange(db, productId, oldSlug, newSlug) {
  const old = String(oldSlug ?? '').trim().toLowerCase();
  const next = String(newSlug ?? '').trim().toLowerCase();
  const pid = isValidObjectIdString(productId) ? String(productId) : null;
  if (!old || !next || old === next || !pid) return;

  const history = db.collection(HISTORY_COLLECTION);
  const now = new Date();

  await history.updateOne(
    { slug: old },
    {
      $set: {
        slug: old,
        productId: pid,
        redirectTo: next,
        updatedAt: now,
        tombstone: false,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );

  // Collapse chains: entries that redirected TO the old slug now redirect to
  // the new slug directly (prevents A->B->C redirect chains).
  await history.updateMany(
    { redirectTo: old, slug: { $ne: old } },
    { $set: { redirectTo: next, updatedAt: now } },
  );
}

/**
 * Tombstone a slug when its product is deleted: the slug stays reserved and
 * resolves to "not found" rather than being recycled by an unrelated product.
 */
async function tombstoneSlug(db, productId, slug) {
  const s = String(slug ?? '').trim().toLowerCase();
  const pid = isValidObjectIdString(productId) ? String(productId) : null;
  if (!s || !pid) return;
  const now = new Date();
  await db.collection(HISTORY_COLLECTION).updateOne(
    { slug: s },
    {
      $set: { slug: s, productId: pid, redirectTo: null, tombstone: true, updatedAt: now },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}

/** Resolve a historical slug to its current target. */
async function findSlugRedirect(db, slug) {
  const s = String(slug ?? '').trim().toLowerCase();
  if (!s) return null;
  const doc = await findSlugHistory(db, s);
  if (!doc) return null;
  const redirectTo = String(doc.redirectTo || '').trim();
  return {
    slug: s,
    productId: doc.productId ? String(doc.productId) : null,
    redirectTo: redirectTo || null,
    tombstone: !!doc.tombstone,
  };
}

/** Slug suggestions for the admin UI (meaningful name-word alternatives). */
async function suggestSlugs(db, name, excludeProductId, limit = 6) {
  const out = [];
  for (const candidate of generateSlugCandidates(name)) {
    if (out.length >= limit) break;
    const availability = await checkSlugAvailability(db, candidate, excludeProductId);
    if (availability.available) out.push(candidate);
  }
  return out;
}

module.exports = {
  SLUG_MAX_LENGTH,
  SLUG_DEFAULT_WORDS,
  RESERVED_SLUGS,
  HISTORY_COLLECTION,
  SlugError,
  normalizeSlugText,
  nameToWords,
  wordsToSlug,
  generateSlugCandidates,
  validateSlugFormat,
  checkSlugAvailability,
  resolveProductSlug,
  recordSlugChange,
  tombstoneSlug,
  findSlugRedirect,
  suggestSlugs,
};
