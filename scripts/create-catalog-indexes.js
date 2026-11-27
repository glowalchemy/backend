/**
 * create-catalog-indexes.js
 *
 * Creates the justified catalog indexes for the current query patterns.
 * Idempotent (createIndex is a no-op when the index already exists).
 *
 * Usage:  node scripts/create-catalog-indexes.js [--dry-run]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const dns = require('node:dns');
const mongoose = require('mongoose');

// Same DNS handling as the API server: SRV lookups (mongodb+srv://) fail on
// networks whose resolver refuses them unless these servers are applied.
const dnsServers = String(process.env.DNS_SERVERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (dnsServers.length) dns.setServers(dnsServers);

const DRY_RUN = process.argv.includes('--dry-run');

const PRODUCT_INDEXES = [
  {
    name: 'slug_unique',
    key: { slug: 1 },
    options: { unique: true },
    why: 'Public product URLs are root-level slugs — must be globally unique. ' +
         'Run scripts/migrate-product-slugs.js first if duplicate slugs exist.',
  },
  {
    name: 'status_visibility_createdAt',
    key: { status: 1, visibility: 1, createdAt: -1 },
    why: 'Default public listing + newest sort (most common catalog query).',
  },
  {
    name: 'category_status_price',
    key: { category: 1, status: 1, price: 1 },
    why: 'Category pages filtered by status, sorted by price.',
  },
  {
    name: 'status_price',
    key: { status: 1, price: 1 },
    why: 'Price-range filters and price sort across the catalog.',
  },
  {
    name: 'tags_1',
    key: { tags: 1 },
    why: 'Tag search/filter ($in + prefix regex on the tags array).',
  },
  {
    name: 'name_1',
    key: { name: 1 },
    why: 'Prefix search on product name (anchored regex can use the index).',
  },
  {
    name: 'rating_status',
    key: { rating: 1, status: 1 },
    why: 'rating_desc sort and rating >= N filter.',
  },
];

const CATEGORY_INDEXES = [
  {
    name: 'parentId_order',
    key: { parentId: 1, order: 1 },
    why: 'Category/subcategory tree queries.',
  },
];

// Every public banner read filters on {position, active} and sorts on
// {order, createdAt}; without this index that is a full collection scan on each
// of the five homepage sections.
const BANNER_INDEXES = [
  {
    name: 'position_active_order_createdAt',
    key: { position: 1, active: 1, order: 1, createdAt: -1 },
    why: 'Public banner reads by position (home_hero, home_ad_grid, ...).',
  },
];

// Guard against duplicate order creation when a checkout request is retried.
// Partial filter keeps the index off legacy orders that have no such field.
const ORDER_INDEXES = [
  {
    name: 'user_clientRequestId',
    key: { user: 1, clientRequestId: 1 },
    options: { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } },
    why: 'Idempotent COD order creation (one order per checkout attempt).',
  },
];

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || '', { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;

  const collections = [
    ['products', PRODUCT_INDEXES],
    ['categories', CATEGORY_INDEXES],
    ['banners', BANNER_INDEXES],
    ['orders', ORDER_INDEXES],
  ];

  for (const [collection, indexes] of collections) {
    console.log(`\n=== ${collection} ===`);
    for (const ix of indexes) {
      console.log(`  ${DRY_RUN ? '[dry-run] would create' : 'creating'} ${ix.name}: ${JSON.stringify(ix.key)}`);
      console.log(`    why: ${ix.why}`);
      if (!DRY_RUN) {
        try {
          await db.collection(collection).createIndex(ix.key, { name: ix.name, ...(ix.options || {}) });
          console.log('    -> ok');
        } catch (e) {
          console.error(`    -> FAILED: ${e.message}`);
        }
      }
    }
  }

  if (DRY_RUN) {
    console.log('\nDry run complete — no indexes created.');
  } else {
    console.log('\nIndexes ensured. Verify with: db.products.getIndexes()');
  }
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
