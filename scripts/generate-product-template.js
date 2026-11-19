/**
 * generate-product-template.js
 *
 * Generates products-template.xlsx — an Excel template for bulk product
 * seeding. Fill the "Products" sheet (one product per row) and import with:
 *
 *   node scripts/import-products.js ./products-template.xlsx --dry-run
 *   node scripts/import-products.js ./products-template.xlsx
 *
 * Re-run this script any time to regenerate a fresh template.
 */

const path = require('path');
const XLSX = require('xlsx');

const HEADERS = [
  'sku',
  'title',
  'selling_price',
  'mrp',
  'qty',
  'brand',
  'category',
  'subcategory',
  'description',
  'image',
  'additional_images',
  'tags',
  'sizes',
  'colors',
  'weight_kg',
  'length_cm',
  'width_cm',
  'height_cm',
  'free_shipping',
  'cod',
  'cod_charge',
  'shipping_charge',
  'sale',
  'discount_percent',
  'status',
  'featured',
  'meta_title',
  'meta_description',
  'source_id',
  'attributes_json',
];

const joinList = (arr) => (arr || []).join(' | ');

// Existing products (mirrors scripts/seed-cosmetic.js) pre-filled as rows.
const EXISTING_PRODUCTS = [
  ['GA-RW-001', 'Rice Water Brightening Face Wash', 299, 399, 100, 'GlowAlchemy', 'Skincare', 'Gentle face wash enriched with rice water for bright and glowing skin. Removes impurities while maintaining natural moisture balance.', 'https://images.unsplash.com/photo-1620916566650-9427b32c8335?w=600&h=600&fit=crop', '', joinList(['Face Wash', 'Rice Water', 'Brightening', 'Natural']), '', '', 0.1, 5, 10, 'true', 'true', 0, 0, 'true', 25, 'active', 'true', '', '', '', ''],
  ['GA-HC-001', 'Herbal Hair Conditioner', 349, 449, 80, 'GlowAlchemy', 'Haircare', 'Nourishing hair conditioner with herbal extracts for soft, smooth, and manageable hair. Suitable for all hair types.', 'https://images.unsplash.com/photo-1570194065340-dc8ea937c859?w=600&h=600&fit=crop', '', joinList(['Conditioner', 'Herbal', 'Hair Care', 'Natural']), '', '', 0.2, 6, 6, 15, 'true', 'true', 0, 0, 'true', 22, 'active', 'true', '', '', '', ''],
  ['GA-NS-001', 'Nourishing Shampoo', 279, 349, 120, 'GlowAlchemy', 'Haircare', 'Deep cleansing shampoo with natural ingredients for healthy hair growth. Removes dirt and excess oil without stripping natural moisture.', 'https://images.unsplash.com/photo-1598440947619-2c35fc9ae54e?w=600&h=600&fit=crop', '', joinList(['Shampoo', 'Hair Care', 'Nourishing', 'Natural']), '', '', 0.2, 6, 6, 15, 'true', 'true', 0, 0, 'true', 20, 'active', 'true', '', '', '', ''],
  ['GA-HM-001', 'Deep Repair Hair Mask', 449, 599, 60, 'GlowAlchemy', 'Haircare', 'Intensive hair mask for damaged hair. Repairs and strengthens hair from root to tip with natural protein extracts.', 'https://images.unsplash.com/photo-1576426863848-c21f53c60b19?w=600&h=600&fit=crop', '', joinList(['Hair Mask', 'Repair', 'Deep Conditioning', 'Natural']), '', '', 0.25, 7, 7, 8, 'true', 'true', 0, 0, 'true', 25, 'active', 'true', '', '', '', ''],
  ['GA-BL-001', 'Hydrating Body Lotion', 329, 429, 90, 'GlowAlchemy', 'Body Care', 'Luxurious body lotion that deeply moisturizes and nourishes skin. Long-lasting hydration with natural ingredients.', 'https://images.unsplash.com/photo-1608248597279-f99d160bfbc8?w=600&h=600&fit=crop', '', joinList(['Body Lotion', 'Hydrating', 'Moisturizing', 'Natural']), '', '', 0.2, 6, 6, 12, 'true', 'true', 0, 0, 'true', 23, 'active', 'true', '', '', '', ''],
  ['GA-FS-001', 'Vitamin C Face Serum', 599, 799, 50, 'GlowAlchemy', 'Face Care', 'Brightening face serum with Vitamin C for radiant and even-toned skin. Reduces dark spots and improves skin texture.', 'https://images.unsplash.com/photo-1596462502278-27bfdc403348?w=600&h=600&fit=crop', '', joinList(['Serum', 'Vitamin C', 'Brightening', 'Anti-aging']), '', '', 0.03, 4, 4, 10, 'true', 'true', 0, 0, 'true', 25, 'active', 'true', '', '', '', ''],
  ['GA-FM-001', 'Organic Face Mask', 399, 499, 70, 'GlowAlchemy', 'Face Care', 'Natural clay face mask for deep cleansing and detoxification. Removes impurities and tightens pores for clear skin.', 'https://images.unsplash.com/photo-1556228578-0d85b6a9be99?w=600&h=600&fit=crop', '', joinList(['Face Mask', 'Clay', 'Detox', 'Organic']), '', '', 0.1, 5, 5, 8, 'true', 'true', 0, 0, 'true', 20, 'active', 'true', '', '', '', ''],
  ['GA-LB-001', 'Nourishing Lip Balm', 149, 199, 150, 'GlowAlchemy', 'Lip Care', 'Moisturizing lip balm with natural oils for soft and hydrated lips. Protects from dryness and chapping.', 'https://images.unsplash.com/photo-1586495777744-4413f21062fa?w=600&h=600&fit=crop', '', joinList(['Lip Balm', 'Moisturizing', 'Natural', 'Organic']), '', '', 0.015, 3, 3, 2, 'true', 'false', 0, 50, 'false', 0, 'active', 'true', '', '', '', ''],
];

const SAMPLE_ROWS = EXISTING_PRODUCTS;

const INSTRUCTIONS = [
  ['GlowAlchemy — Product Import Template'],
  [''],
  ['Sheet "Products": one product per row. Row 1 is the header — do not rename, reorder, or delete columns.'],
  ['The existing GlowAlchemy products are pre-filled — edit them or add new rows below.'],
  [''],
  ['Column guide:'],
  ['sku', 'REQUIRED — unique product code. Re-importing same SKU skips (or updates with --update).'],
  ['title', 'REQUIRED — product name.'],
  ['selling_price', 'REQUIRED — selling price (number).'],
  ['mrp', 'Original / compare-at price (number). Defaults to selling_price if empty.'],
  ['qty', 'Stock quantity (number).'],
  ['brand', 'Brand name (default: GlowAlchemy).'],
  ['category', 'Category name or slug — must already exist in the database.'],
  ['subcategory', 'Optional subcategory name or slug.'],
  ['description', 'Short product description.'],
  ['image', 'Main image URL (https).'],
  ['additional_images', 'More image URLs separated by | or ;'],
  ['tags', 'Comma or | separated tags.'],
  ['sizes', 'Sizes separated by | (e.g. S | M | L | XL).'],
  ['colors', 'Colors separated by | (e.g. Red | Blue | Green).'],
  ['weight_kg', 'Weight in kg (number).'],
  ['length_cm / width_cm / height_cm', 'Package dimensions in cm (numbers).'],
  ['free_shipping', 'true / false'],
  ['cod', 'Cash on delivery available — true / false'],
  ['cod_charge', 'COD charge amount (number).'],
  ['shipping_charge', 'Shipping charge amount (number).'],
  ['sale', 'true / false — enable discount below.'],
  ['discount_percent', 'Discount percent when sale=true.'],
  ['status', 'active or draft (default: active).'],
  ['featured', 'true / false — show on featured sections.'],
  ['meta_title / meta_description', 'SEO fields (optional).'],
  ['source_id', 'Optional external supplier product id.'],
  ['attributes_json', 'Optional JSON array of attribute sets, e.g. [{"name":"Skin Type","values":["Dry","Oily"]}]'],
  [''],
  ['How to import:'],
  ['  1. node scripts/import-products.js ./products-template.xlsx --dry-run   (test, no writes)'],
  ['  2. node scripts/import-products.js ./products-template.xlsx           (import)'],
  ['  3. node scripts/import-products.js ./products-template.xlsx --update  (overwrite existing SKUs)'],
];

function main() {
  const wb = XLSX.utils.book_new();

  const wsInfo = XLSX.utils.aoa_to_sheet(INSTRUCTIONS);
  wsInfo['!cols'] = [{ wch: 90 }];
  XLSX.utils.book_append_sheet(wb, wsInfo, 'Instructions');

  const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...SAMPLE_ROWS]);
  ws['!cols'] = HEADERS.map((h) => ({ wch: Math.max(h.length + 2, 14) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Products');

  const out = path.join(__dirname, '..', 'products-template.xlsx');
  XLSX.writeFile(wb, out);
  console.log(`Template written to ${out}`);
}

main();
