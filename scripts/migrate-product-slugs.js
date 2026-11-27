/**
 * migrate-product-slugs.js
 *
 * One-time, idempotent migration that brings every product onto the
 * centralized slug rules:
 *
 *   - Valid existing slugs are PRESERVED untouched.
 *   - Missing / invalid / duplicate / reserved slugs get a proposed slug
 *     generated from the first three meaningful product-name words
 *     (meaningful alternatives on conflict — never random suffixes).
 *   - Changed slugs are recorded in `product_slug_history` so the old URL
 *     keeps resolving (redirect registry).
 *   - A unique index on `products.slug` is created once no duplicates remain.
 *
 * Usage:
 *   node scripts/migrate-product-slugs.js                 # dry-run report (default)
 *   node scripts/migrate-product-slugs.js --apply         # write changes
 *   node scripts/migrate-product-slugs.js --apply --report report.json
 *   node scripts/migrate-product-slugs.js --rollback <backup.json>
 *
 * Safety:
 *   - Never deletes products, never touches _id or relational fields.
 *   - --apply writes a full rollback backup before changing anything.
 *   - Dry-run is the default; nothing is written without --apply.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const dns = require('node:dns');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const slugService = require('../src/services/productSlugService');

const dnsServers = String(process.env.DNS_SERVERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (dnsServers.length) dns.setServers(dnsServers);

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const REPORT_IDX = args.indexOf('--report');
const REPORT_PATH = REPORT_IDX >= 0 ? args[REPORT_IDX + 1] : null;
const ROLLBACK_IDX = args.indexOf('--rollback');
const ROLLBACK_PATH = ROLLBACK_IDX >= 0 ? args[ROLLBACK_IDX + 1] : null;

const backupDir = path.join(__dirname, 'slug-migration-backups');

function classifySlug(slug) {
  const s = String(slug ?? '').trim().toLowerCase();
  if (!s) return 'missing';
  const fmt = slugService.validateSlugFormat(s);
  if (fmt) {
    if (fmt.code === 'SLUG_RESERVED') return 'reserved';
    return 'invalid';
  }
  return 'candidate-valid';
}

async function buildPlan(db) {
  const products = await db.collection('products')
    .find({}, { projection: { slug: 1, name: 1, status: 1, slugGenerationMode: 1 } })
    .toArray();

  // Detect duplicate current slugs
  const slugCounts = new Map();
  for (const p of products) {
    const s = String(p.slug ?? '').trim().toLowerCase();
    if (!s) continue;
    slugCounts.set(s, (slugCounts.get(s) || 0) + 1);
  }

  const history = await db.collection(slugService.HISTORY_COLLECTION)
    .find({}, { projection: { slug: 1 } })
    .toArray();
  const historicalSlugs = new Set(history.map((h) => String(h.slug || '').toLowerCase()));

  const plan = [];
  const seenAssigned = new Set(); // slugs claimed during this run

  for (const p of products) {
    const id = String(p._id);
    const name = String(p.name || '');
    const current = String(p.slug ?? '').trim();
    const normalized = current.toLowerCase();
    const cls = classifySlug(current);
    const isDuplicate = slugCounts.get(normalized) > 1;
    const isHistorical = historicalSlugs.has(normalized);

    const entry = {
      id,
      name,
      currentSlug: current || null,
      classification: cls,
      action: 'keep',
      proposedSlug: null,
      reason: '',
    };

    const mustChange =
      cls === 'missing' || cls === 'invalid' || cls === 'reserved' ||
      isDuplicate || isHistorical;

    if (!mustChange) {
      entry.reason = 'valid unique slug';
      seenAssigned.add(normalized);
      plan.push(entry);
      continue;
    }

    entry.classification = isDuplicate ? 'duplicate'
      : isHistorical ? 'historical-conflict'
      : cls;
    entry.reason = isDuplicate ? 'duplicate slug'
      : isHistorical ? 'slug collides with redirect history'
      : cls === 'missing' ? 'no slug'
      : cls === 'reserved' ? 'reserved route'
      : 'invalid format';

    // Find the first meaningful candidate not claimed by another product,
    // not historical, not reserved.
    let chosen = null;
    for (const candidate of slugService.generateSlugCandidates(name)) {
      const c = candidate.toLowerCase();
      if (seenAssigned.has(c) || historicalSlugs.has(c)) continue;
      if (slugService.RESERVED_SLUGS.has(c)) continue;
      const owner = await db.collection('products').findOne(
        { slug: candidate },
        { projection: { _id: 1 } },
      );
      if (owner && String(owner._id) !== id) continue;
      chosen = candidate;
      break;
    }

    if (!chosen) {
      entry.action = 'review-required';
      entry.reason += '; no unique meaningful slug available — admin review needed';
    } else {
      entry.action = 'update';
      entry.proposedSlug = chosen;
      seenAssigned.add(chosen.toLowerCase());
    }
    plan.push(entry);
  }

  return plan;
}

async function applyPlan(db, plan) {
  const changes = [];
  const { ObjectId } = mongoose.Types;

  for (const entry of plan) {
    if (entry.action !== 'update' || !entry.proposedSlug) continue;

    const before = await db.collection('products').findOne(
      { _id: new ObjectId(entry.id) },
      { projection: { slug: 1, name: 1 } },
    );
    if (!before) continue;

    const oldSlug = String(before.slug ?? '').trim();
    await db.collection('products').updateOne(
      { _id: new ObjectId(entry.id) },
      {
        $set: {
          slug: entry.proposedSlug,
          slugGenerationMode: 'auto',
          slugUpdatedAt: new Date(),
          updatedAt: new Date(),
        },
      },
    );

    if (oldSlug && oldSlug.toLowerCase() !== entry.proposedSlug.toLowerCase()) {
      // Old (possibly malformed) slug still gets a redirect entry when it is
      // a valid-format slug; malformed slugs never resolved publicly anyway.
      if (!slugService.validateSlugFormat(oldSlug)) {
        await slugService.recordSlugChange(db, entry.id, oldSlug, entry.proposedSlug);
      }
    }

    changes.push({
      id: entry.id,
      name: entry.name,
      from: oldSlug || null,
      to: entry.proposedSlug,
    });
  }

  // Duplicate slugs that were kept are impossible post-plan (all dupes get a
  // proposed slug), but guard anyway: report any remaining duplicates.
  const remaining = await db.collection('products').aggregate([
    { $match: { slug: { $exists: true, $ne: '' } } },
    { $group: { _id: '$slug', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();

  return { changes, remainingDuplicates: remaining.map((r) => r._id) };
}

async function rollback(db, backupPath) {
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  const { ObjectId } = mongoose.Types;
  const restored = [];

  for (const change of backup.changes || []) {
    await db.collection('products').updateOne(
      { _id: new ObjectId(change.id) },
      { $set: { slug: change.from ?? '', updatedAt: new Date() } },
    );
    restored.push(change.id);
    // Remove the history entry created for this change, if the redirect still
    // points at the migrated slug.
    if (change.from) {
      await db.collection(slugService.HISTORY_COLLECTION).deleteOne({
        slug: String(change.from).toLowerCase(),
        redirectTo: String(change.to).toLowerCase(),
      });
    }
  }
  return restored;
}

function printReport(plan) {
  const counts = { keep: 0, update: 0, 'review-required': 0 };
  for (const e of plan) counts[e.action] = (counts[e.action] || 0) + 1;

  console.log('\n================ PRODUCT SLUG MIGRATION REPORT ================');
  console.log(`Total products : ${plan.length}`);
  console.log(`Keep as-is     : ${counts.keep}`);
  console.log(`Will update    : ${counts.update}`);
  console.log(`Needs review   : ${counts['review-required']}`);
  console.log('---------------------------------------------------------------');

  const updates = plan.filter((e) => e.action === 'update');
  if (updates.length) {
    console.log('\nProposed slug mapping:');
    for (const e of updates) {
      console.log(`  ${e.currentSlug || '(none)'}  ->  ${e.proposedSlug}   [${e.name}]`);
    }
  }

  const review = plan.filter((e) => e.action === 'review-required');
  if (review.length) {
    console.log('\nRequires admin review (no unique meaningful slug found):');
    for (const e of review) {
      console.log(`  [${e.id}] ${e.name} (current: ${e.currentSlug || 'none'}) — ${e.reason}`);
    }
  }

  const collisions = plan.filter((e) => ['duplicate', 'historical-conflict'].includes(e.classification));
  if (collisions.length) {
    console.log('\nCollision report:');
    for (const e of collisions) {
      console.log(`  ${e.currentSlug || '(none)'} — ${e.classification} — ${e.name}`);
    }
  }
  console.log('===============================================================\n');
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || '', { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;

  if (ROLLBACK_PATH) {
    const restored = await rollback(db, path.resolve(ROLLBACK_PATH));
    console.log(`Rollback complete: ${restored.length} product slug(s) restored.`);
    await mongoose.disconnect();
    return;
  }

  const plan = await buildPlan(db);
  printReport(plan);

  if (REPORT_PATH) {
    fs.writeFileSync(path.resolve(REPORT_PATH), JSON.stringify(plan, null, 2));
    console.log(`Plan written to ${path.resolve(REPORT_PATH)}`);
  }

  if (!APPLY) {
    console.log('Dry run only — re-run with --apply to write changes.');
    await mongoose.disconnect();
    return;
  }

  // Backup before writing anything.
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `slug-backup-${Date.now()}.json`);
  const backup = {
    createdAt: new Date().toISOString(),
    changes: plan
      .filter((e) => e.action === 'update')
      .map((e) => ({ id: e.id, name: e.name, from: e.currentSlug, to: e.proposedSlug })),
  };
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`Rollback backup written to ${backupPath}`);

  const { changes, remainingDuplicates } = await applyPlan(db, plan);
  console.log(`Applied ${changes.length} slug update(s).`);

  if (remainingDuplicates.length) {
    console.log(`WARNING: duplicate slugs remain: ${remainingDuplicates.join(', ')} — unique index NOT created.`);
  } else {
    // Create the unique index now that slugs are unique.
    try {
      await db.collection('products').createIndex(
        { slug: 1 },
        { unique: true, name: 'slug_unique' },
      );
      console.log('Unique index slug_unique created on products.slug.');
    } catch (e) {
      console.error(`Failed to create unique index (existing duplicates?): ${e.message}`);
    }
  }

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
