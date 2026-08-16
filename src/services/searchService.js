/**
 * searchService.js
 *
 * Current-stage search provider — optimized MongoDB queries with proper
 * normalization and relevance ranking. This is the "MongoCurrentProvider".
 *
 * Future: when the catalog/traffic justifies it, swap the provider for an
 * Atlas Search implementation behind the same small interface
 * (searchCatalog / getSuggestions) without touching the API layer or UI.
 *
 * Strategy (deliberately NOT unrestricted unanchored regex over many fields):
 *  1. normalize the query (lowercase, punctuation-strip, collapse spaces)
 *  2. build an OR filter of indexed-friendly matches:
 *       exact name → prefix name/brand/category/tags/sku → per-token prefixes
 *       → bounded substring fallback ONLY for queries >= minChars
 *  3. fetch a bounded candidate set (searchResultCap), score in JS by match
 *     type, sort by relevance (newest as tiebreak), then slice.
 */

const { normalizeText, buildSearchProjection, toFiniteNumber, toTrimmedString } = require('./productNormalizer');

const MIN_CHARS = Number(process.env.SEARCH_AUTOCOMPLETE_MIN_CHARS || 3);
const SEARCH_CANDIDATE_CAP = Number(process.env.SEARCH_CANDIDATE_CAP || 150);

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeQuery(value) {
  return normalizeText(String(value || ''));
}

function tokenizeQuery(q) {
  return normalizeQuery(q).split(' ').filter((t) => t.length > 0);
}

/**
 * Build the Mongo filter for a search query, combined with the caller's base
 * filter (status/visibility etc.). Returns { filter, tokens, full, substringUsed }.
 */
function buildSearchFilter(q, baseFilter = {}, options = {}) {
  const minChars = Number.isFinite(Number(options.minChars)) ? Number(options.minChars) : MIN_CHARS;
  const full = normalizeQuery(q);
  const tokens = tokenizeQuery(full);

  const or = [];
  let substringUsed = false;

  if (full) {
    const exact = new RegExp(`^${escapeRegExp(full)}$`, 'i');
    const prefix = new RegExp(`^${escapeRegExp(full)}`, 'i');
    or.push({ name: exact });
    or.push({ name: prefix });
    or.push({ brand: prefix });
    or.push({ category: prefix });
    or.push({ 'management.basic.brand': prefix });
    or.push({ sku: exact });
    for (const t of tokens) {
      if (t.length < 2) continue;
      const tPrefix = new RegExp(`^${escapeRegExp(t)}`, 'i');
      or.push({ name: tPrefix });
      or.push({ tags: tPrefix });
      or.push({ 'management.basic.brand': tPrefix });
    }
    // Bounded substring fallback — only for sufficiently long queries.
    if (full.length >= minChars) {
      substringUsed = true;
      const sub = new RegExp(escapeRegExp(full), 'i');
      or.push({ name: sub });
      or.push({ tags: sub });
      or.push({ brand: sub });
      or.push({ sku: sub });
    }
  }

  const filter = { ...baseFilter };
  if (or.length) filter.$or = or;
  return { filter, tokens, full, substringUsed };
}

/** Relevance score for one product (search projection) against the query tokens. */
function scoreProduct(proj, tokens, full) {
  if (!proj) return 0;
  let score = 0;
  const name = String(proj.name || '').toLowerCase();
  const brand = String(proj.brand || '').toLowerCase();
  const normName = String(proj.normalizedName || '');

  if (full && normName === full) score += 100; // exact product-name match
  if (full && name.startsWith(full)) score += 80; // prefix product-name
  if (full && brand && (brand === full || brand.startsWith(full))) score += 50; // exact brand match
  if (full && String(proj.category || '').toLowerCase().startsWith(full)) score += 45;

  for (const t of tokens) {
    if (!t) continue;
    if (normName.includes(t)) score += 20;
    if (name.startsWith(t)) score += 10;
    if ((proj.searchableTags || []).some((tag) => String(tag).toLowerCase().includes(t))) score += 25;
    if (brand.includes(t)) score += 15;
    if ((proj.searchableAttributes || []).some((a) => a.includes(t))) score += 20;
    if (String(proj.sku || '').toLowerCase().includes(t)) score += 60;
  }

  // Bounded substring bonus for long queries.
  if (full && name.includes(full) && !name.startsWith(full)) score += 15;

  return score;
}

/** Rank a candidate list by relevance; newest wins ties. */
function rankProducts(products, tokens, full) {
  const scored = (products || []).map((p) => {
    const proj = buildSearchProjection(p);
    const score = scoreProduct(proj, tokens, full);
    return { p, proj, score };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const at = new Date(a.p.createdAt || 0).getTime();
    const bt = new Date(b.p.createdAt || 0).getTime();
    return bt - at;
  });
  return scored;
}

function minCharsSetting() {
  const v = Number(process.env.SEARCH_AUTOCOMPLETE_MIN_CHARS);
  return Number.isFinite(v) && v > 0 ? v : MIN_CHARS;
}

function candidateCap() {
  const v = Number(process.env.SEARCH_CANDIDATE_CAP);
  return Number.isFinite(v) && v > 0 ? v : SEARCH_CANDIDATE_CAP;
}

module.exports = {
  normalizeQuery,
  tokenizeQuery,
  buildSearchFilter,
  scoreProduct,
  rankProducts,
  minCharsSetting,
  candidateCap,
  escapeRegExp,
  toFiniteNumber,
  toTrimmedString,
};
