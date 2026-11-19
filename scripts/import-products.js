/**
 * import-products.js — CLI product importer.
 *
 * Usage:
 *   node scripts/import-products.js ./products.csv [--dry-run] [--update] [--offset N] [--batch 50]
 *   node scripts/import-products.js ./products.json [--dry-run] [--update]
 *   node scripts/import-products.js ./products.xlsx [--dry-run] [--update]
 *
 * CSV columns (aliases accepted): sku, title/name, selling_price/price/mrp,
 *   qty/stock, brand, category, subcategory, description, image/image_url,
 *   images, tags, weight_kg, length_cm, width_cm, height_cm, free_shipping,
 *   cod, cod_charge, shipping_charge, discount_percent, sizes, colors, status,
 *   source_id, attributes_json, ...
 *
 * JSON: array of row objects (same field names as CSV).
 * XLSX: first sheet, first row = headers (same field names as CSV).
 *
 * Safety: --dry-run default-safe; never deletes; idempotent by SKU.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const { importProducts } = require('../src/services/importService');

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const update = args.includes('--update');
const offset = Number(args[args.indexOf('--offset') + 1]) || 0;
const batch = Number(args[args.indexOf('--batch') + 1]) || 50;

if (!filePath) {
  console.error('Usage: node scripts/import-products.js <file.csv|file.json> [--dry-run] [--update] [--offset N] [--batch N]');
  process.exit(1);
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map((line) => {
    const cells = [];
    let cur = '';
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    const row = {};
    headers.forEach((h, i) => { row[h] = (cells[i] || '').trim(); });
    return row;
  });
}

async function main() {
  const ext = path.extname(filePath).toLowerCase();
  let rows;
  if (ext === '.json') {
    rows = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(rows)) rows = [rows];
  } else if (ext === '.csv') {
    rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
  } else if (ext === '.xlsx' || ext === '.xls') {
    const wb = XLSX.read(fs.readFileSync(filePath), { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: '' }).map((r) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [String(k).trim(), v]))
    );
  } else {
    console.error('Unsupported file type (use .csv, .xlsx or .json)');
    process.exit(1);
  }

  console.log(`Loaded ${rows.length} rows from ${filePath}`);
  if (dryRun) console.log('DRY RUN — no writes will be made.');
  if (update) console.log('UPDATE mode — existing SKUs will be overwritten.');

  await mongoose.connect(process.env.MONGODB_URI || '', { serverSelectionTimeoutMS: 20000 });
  const stats = await importProducts(rows, { dryRun, update, batchSize: batch, offset, onProgress: ({ processed, total, stats: s }) => {
    if (processed % (batch * 5) === 0 || processed === total) {
      console.log(`  progress ${processed}/${total} (imported=${s.imported} updated=${s.updated} skipped=${s.skipped} failed=${s.failed})`);
    }
  } });
  await mongoose.disconnect();

  console.log('\n=== IMPORT SUMMARY ===');
  console.log(`  imported: ${stats.imported}`);
  console.log(`  updated:  ${stats.updated}`);
  console.log(`  skipped:  ${stats.skipped} (existing SKUs, use --update to overwrite)`);
  console.log(`  failed:   ${stats.failed}`);
  if (stats.errors.length) {
    console.log('\nFirst errors:');
    for (const e of stats.errors.slice(0, 10)) console.log(`  row ${e.index}: ${e.message}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
