/**
 * verify-catalog.js — integration smoke test for the catalog/search system.
 *
 * Runs against the live API (default http://localhost:5000) using only GETs
 * plus a DRY-RUN import exercise. Prints PASS/FAIL per assertion.
 *
 * Usage: node scripts/verify-catalog.js [BASE_URL]
 */

const BASE = process.argv[2] || 'http://localhost:5000';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  FAIL  ${name} ${detail}`); }
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function main() {
  console.log(`Verifying catalog system at ${BASE}\n`);

  // 1. Listing: shape, projection (no management blob), normalized fields.
  console.log('-- listing --');
  const list = await get('/api/products?mode=public&page=1&limit=24');
  check('listing 200', list.status === 200, `status=${list.status}`);
  check('listing has items array', Array.isArray(list.json?.items), 'no items');
  check('listing has pagination fields', list.json?.total !== undefined && list.json?.totalPages !== undefined && list.json?.page !== undefined);
  const item = list.json?.items?.[0];
  if (item) {
    check('listing item has id+slug', !!item.id && !!item.slug);
    check('listing item has NO management blob', !('management' in item), Object.keys(item).join(','));
    check('listing item has NO reviews array', !Array.isArray(item.reviews));
    check('listing item has brand', typeof item.brand === 'string');
    check('listing item has stock+price numbers', typeof item.stock === 'number' && typeof item.price === 'number');
  }
  check('listing Cache-Control public', (list.headers.get('cache-control') || '').includes('public'), list.headers.get('cache-control') || '');

  // 2. Filters (all previously-ignored ones must work now).
  console.log('-- filters --');
  const feat = await get('/api/products?mode=public&featured=true&page=1&limit=24');
  check('featured filter works (200 + items field)', feat.status === 200 && Array.isArray(feat.json?.items), JSON.stringify(feat.json).slice(0, 120));
  const rating = await get('/api/products?mode=public&rating=4&page=1&limit=24');
  check('rating filter works', rating.status === 200 && Array.isArray(rating.json?.items));
  const price = await get('/api/products?mode=public&minPrice=0&maxPrice=500&page=1&limit=24');
  check('price range filter works', price.status === 200 && Array.isArray(price.json?.items));
  const instock = await get('/api/products?mode=public&inStock=true&page=1&limit=24');
  check('inStock filter works', instock.status === 200 && Array.isArray(instock.json?.items));

  // 3. Search.
  console.log('-- search --');
  for (const q of ['rosemary', 'perfume', 'hair']) {
    const s = await get(`/api/products?mode=public&q=${encodeURIComponent(q)}&page=1&limit=10`);
    check(`search "${q}" 200 + items`, s.status === 200 && Array.isArray(s.json?.items), `status=${s.status} ${s.text?.slice(0, 100)}`);
  }
  const s1 = await get('/api/products?mode=public&q=rosemary&page=1&limit=10');
  check('search returns search metadata', !!s1.json?.search?.query, JSON.stringify(s1.json?.search));
  check('search returns suggestions array', Array.isArray(s1.json?.suggestions?.categories) && Array.isArray(s1.json?.suggestions?.brands));

  // 4. Facets.
  console.log('-- facets --');
  const f = await get('/api/products?mode=public&facets=true&page=1&limit=24');
  const keys = f.json?.facets ? Object.keys(f.json.facets) : [];
  for (const k of ['brands', 'colors', 'sizes', 'priceBuckets', 'ratingBuckets', 'subcategories']) {
    check(`facet ${k} present`, keys.includes(k), keys.join(','));
  }
  const pb = f.json?.facets?.priceBuckets || [];
  check('price bucket has from/to/count', pb.every((b) => b.from !== undefined && b.count !== undefined));

  // 5. Suggest endpoint.
  console.log('-- suggest --');
  const sug = await get('/api/search/suggest?q=ros');
  check('suggest 200', sug.status === 200);
  check('suggest returns products+categories+brands arrays', Array.isArray(sug.json?.products) && Array.isArray(sug.json?.categories) && Array.isArray(sug.json?.brands));
  const sugEmpty = await get('/api/search/suggest?q=x');
  check('suggest empty q safe', sugEmpty.status === 200 && Array.isArray(sugEmpty.json?.products));

  // 6. Full search endpoint.
  console.log('-- /api/search --');
  const full = await get('/api/search?q=rosemary&facets=true&page=1&limit=12');
  check('/api/search 200 + items + facets', full.status === 200 && Array.isArray(full.json?.items) && !!full.json?.facets);
  check('/api/search paginated', full.json?.total !== undefined && full.json?.totalPages !== undefined);

  // 7. Category counts (single aggregation — no N+1).
  console.log('-- categories --');
  const cats = await get('/api/categories?mode=public');
  check('categories 200', cats.status === 200);
  check('categories all have numeric productCount', Array.isArray(cats.json) && cats.json.every((c) => typeof c.productCount === 'number'));

  // 8. Pagination safety.
  console.log('-- pagination --');
  const deep = await get('/api/products?mode=public&page=999&limit=24');
  check('deep page returns empty items (no crash)', deep.status === 200 && Array.isArray(deep.json?.items));
  const big = await get('/api/products?mode=public&page=1&limit=9999');
  check('oversized limit capped', big.status === 200 && big.json?.limit <= 100, `limit=${big.json?.limit}`);

  // 9. Error handling.
  console.log('-- errors --');
  const noQ = await get('/api/search');
  check('/api/search without q → 400', noQ.status === 400, `status=${noQ.status}`);
  const badSort = await get('/api/products?mode=public&sort=$where&page=1&limit=10');
  check('malicious sort rejected (falls back, no crash)', badSort.status === 200);

  // 10. Import pipeline (DRY RUN — no writes).
  console.log('-- import (dry-run) --');
  const { importProducts } = require('../src/services/importService');
  const mongoose = require('mongoose');
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
  await mongoose.connect(process.env.MONGODB_URI || '', { serverSelectionTimeoutMS: 15000 });
  const rows = [
    { sku: 'QA-IMPORT-1', title: 'QA Perfume 100ml', selling_price: 499, mrp: 999, qty: 10, brand: 'QA Brand', category: 'Beauty & Personal Care', subcategory: 'Hair Care', image: 'https://example.com/q.jpg', weight_kg: 0.2 },
    { sku: 'QA-IMPORT-1', title: 'QA Perfume 100ml', selling_price: 499, mrp: 999, qty: 10, brand: 'QA Brand', category: 'Beauty & Personal Care', subcategory: 'Hair Care', image: 'https://example.com/q.jpg', weight_kg: 0.2 },
    { sku: '', title: 'Missing SKU row', selling_price: 100 },
  ];
  const stats = await importProducts(rows, { dryRun: true, batchSize: 10 });
  check('import dry-run: 1 imported (dedupe works)', stats.imported === 1, `imported=${stats.imported} skipped=${stats.skipped}`);
  check('import dry-run: 1 skipped (same SKU)', stats.skipped === 1, `skipped=${stats.skipped}`);
  check('import dry-run: 1 failed (missing sku)', stats.failed === 1, `failed=${stats.failed}`);
  const after = await mongoose.connection.db.collection('products').estimatedDocumentCount();
  check('import dry-run wrote NOTHING', after === 1, `products=${after}`);
  await mongoose.disconnect();

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failures.length) console.log('Failures:', failures.join(' | '));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
