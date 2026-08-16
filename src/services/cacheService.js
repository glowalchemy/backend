/**
 * cacheService.js
 *
 * Small in-process TTL cache for SAFE public catalog responses only
 * (product listings, category trees, search suggestions, facets).
 *
 * NEVER cache:
 *  - customer-specific state (cart, wishlist, orders)
 *  - inventory/order totals
 *  - authenticated/admin responses
 *  - anything containing credentials
 *
 * This is a bounded, best-effort cache — it is NOT a source of truth.
 * Catalog writes call invalidateAll() so mutations surface promptly; the TTL
 * is the primary expiry mechanism.
 */

const DEFAULT_TTL_SECONDS = Number(process.env.CATALOG_CACHE_TTL_SECONDS || 15);
const MAX_ENTRIES = Number(process.env.CATALOG_CACHE_MAX_ENTRIES || 300);

const store = new Map(); // key -> { value, expiresAt }

function ttlSeconds() {
  const v = Number(process.env.CATALOG_CACHE_TTL_SECONDS);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_TTL_SECONDS;
}

function pruneIfNeeded() {
  if (store.size <= MAX_ENTRIES) return;
  const now = Date.now();
  for (const [k, entry] of store) {
    if (entry.expiresAt <= now) store.delete(k);
  }
  if (store.size > MAX_ENTRIES) {
    // Evict oldest entries (Map preserves insertion order).
    const overflow = store.size - MAX_ENTRIES;
    let i = 0;
    for (const k of store.keys()) {
      if (i >= overflow) break;
      store.delete(k);
      i += 1;
    }
  }
}

function get(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

function set(key, value, ttl = ttlSeconds()) {
  if (ttl <= 0) return value;
  store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
  pruneIfNeeded();
  return value;
}

function getOrSet(key, fn, ttl) {
  const hit = get(key);
  if (hit !== undefined) return { value: hit, cached: true };
  const value = fn();
  if (value && typeof value.then === 'function') {
    return value.then((resolved) => ({ value: set(key, resolved, ttl), cached: false }));
  }
  return { value: set(key, value, ttl), cached: false };
}

function invalidateAll() {
  store.clear();
}

function stats() {
  return { size: store.size, maxEntries: MAX_ENTRIES, defaultTtlSeconds: ttlSeconds() };
}

module.exports = { get, set, getOrSet, invalidateAll, stats, ttlSeconds };
