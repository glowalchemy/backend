/**
 * create-catalog-indexes.js
 *
 * Creates the justified catalog indexes for the current query patterns.
 * Idempotent (createIndex is a no-op when the index already exists).
 *
 * Usage:  node scripts/create-catalog-indexes.js [--dry-run]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const DRY_RUN = process.argv.includes('--dry-run');

const PRODUCT_INDEXES = [
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

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || '', { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;

  for (const [collection, indexes] of [['products', PRODUCT_INDEXES], ['categories', CATEGORY_INDEXES]]) {
    console.log(`\n=== ${collection} ===`);
    for (const ix of indexes) {
      console.log(`  ${DRY_RUN ? '[dry-run] would create' : 'creating'} ${ix.name}: ${JSON.stringify(ix.key)}`);
      console.log(`    why: ${ix.why}`);
      if (!DRY_RUN) {
        try {
          await db.collection(collection).createIndex(ix.key, { name: ix.name });
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
