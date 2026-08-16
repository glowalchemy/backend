/**
 * TEMPORARY SEED SCRIPT — Rosemaryy test product.
 *
 * Creates ONE test product through the application's REAL admin creation path
 * (POST /api/products/publish, the same route the Admin UI uses), referencing
 * the already-uploaded private Backblaze object `image.png`.
 *
 * It does NOT upload the image again, does NOT make the bucket public, and
 * never prints credentials or signed URLs.
 *
 * Because the publish route requires an admin JWT and an existing
 * category + sub-category (validateSubCategoryOrThrow), this script also
 * creates (only if missing) a minimal seed admin and the
 * `Beauty & Personal Care → Hair Care` category structure.
 *
 * Usage:
 *   node scripts/seed-rosemaryy-test-product.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const crypto = require('crypto');

const config = require('../src/config');
const { AdminModel } = require('../src/models/admin');
const { CategoryModel } = require('../src/models/category');
const storage = require('../src/config/storage');

const IMAGE_KEY = 'image.png'; // existing object at the private bucket root
const SEED_ADMIN_EMAIL = 'seed-admin@glowalchemy.com';

function slugify(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function ensureAdmin() {
  const existing = await AdminModel.findOne({ email: SEED_ADMIN_EMAIL }).select('+password');
  if (existing) return existing;

  const password = crypto.randomBytes(6).toString('hex'); // e.g. "3f9a2c7b1d05"
  const admin = new AdminModel({
    firstName: 'Seed',
    lastName: 'Admin',
    email: SEED_ADMIN_EMAIL,
    password,
    phone: '',
  });
  await admin.save();
  console.log(`  [admin] created seed admin ${SEED_ADMIN_EMAIL} (password printed once below — change it or delete this account afterwards)`);
  console.log(`  [admin] password: ${password}`);
  return admin;
}

async function ensureCategories() {
  const topName = 'Beauty & Personal Care';
  const subName = 'Hair Care';

  let top = await CategoryModel.findOne({ name: topName, parentId: null }).lean();
  if (!top) {
    const doc = new CategoryModel({ name: topName, parentId: null, order: 1, active: true });
    await doc.save();
    top = doc.toObject();
    console.log(`  [category] created top-level "${topName}"`);
  }

  let sub = await CategoryModel.findOne({ name: subName, parentId: String(top._id) }).lean();
  if (!sub) {
    const doc = new CategoryModel({ name: subName, parentId: String(top._id), order: 1, active: true });
    await doc.save();
    sub = doc.toObject();
    console.log(`  [category] created sub-category "${subName}" under ${topName}`);
  }

  return { top, sub };
}

function buildPublishValues(top, sub) {
  const name =
    'Rosemaryy Water Spray For Hair Growth (100 ml) | Hair Spray for Regrowth | Rosemaryy Hair Mist Helps Reduce Hairfall | Strengthens Hair | For All Hair Types |2 PACK|';

  // Stable proxy URL for the private object (never a presigned URL, never a
  // public bucket URL). The backend mints a fresh presigned URL per request.
  const imageProxyPath = storage.proxyPathFor(IMAGE_KEY); // /api/upload/file/image.png

  const imageId = `img-${Date.now()}`;

  return {
    basic: {
      name,
      slug: slugify(name),
      shortDescription:
        'Rosemaryy Water Spray for Hair Growth (100 ml) — hair spray for regrowth that helps reduce hair fall and strengthens hair. Suitable for all hair types. Pack of 2.',
      descriptionHtml:
        '<p>Rosemaryy Water Spray for Hair Growth (100 ml) | Hair Spray for Regrowth | Rosemaryy Hair Mist Helps Reduce Hairfall | Strengthens Hair | For All Hair Types | 2 PACK</p>',
      categoryIds: [String(top._id)],
      subCategoryId: String(sub._id),
      brand: 'MAHI INTERNATIONAL STORE',
      status: 'active',
      visibility: 'public',
    },
    pricing: {
      originalPrice: 224,
      sellingPrice: 224,
      taxClass: 'gst',
      taxRatePercent: 18,
    },
    inventory: {
      sku: 'ROSEMARYY-HAIR-SPRAY-100ML-2PACK',
      stockQuantity: 25,
      lowStockThreshold: 5,
      stockStatus: 'in_stock',
      allowBackorders: false,
      history: [],
    },
    media: {
      images: [
        { id: imageId, url: imageProxyPath, alt: 'Rosemaryy Water Spray For Hair Growth (100 ml) — 2 Pack' },
      ],
      thumbnailId: imageId,
    },
    colorVariants: [],
    attributes: {
      sets: [
        { id: 'attr-size', name: 'Size', values: ['Free Size'], useForVariants: false },
      ],
      variants: [],
      sizeGuideImageUrl: '',
    },
    seo: {
      metaTitle: 'Rosemaryy Water Spray For Hair Growth (100 ml) — 2 Pack',
      metaDescription:
        'Rosemaryy Water Spray for Hair Growth (100 ml) — helps reduce hairfall, strengthens hair, suitable for all hair types. 2 Pack.',
      metaKeywords: ['rosemaryy', 'hair growth spray', 'hair fall', 'hair mist'],
    },
    shipping: {
      weightKg: 0.2,
      dimensionsCm: { length: 6, width: 6, height: 15 },
      shippingClass: 'Standard',
      freeShipping: false,
      codAvailable: true,
      codCharge: 0,
      shippingCharge: 0,
    },
    marketing: {
      featured: false,
      saleBadge: false,
      scheduleSale: { enabled: false, startDate: '', endDate: '' },
      couponEligible: true,
      relatedProductIds: [],
      upsellProductIds: [],
    },
    details: {
      technicalSpecs: [
        { key: 'Ideal For', value: 'Unisex' },
        { key: 'Net Quantity (N)', value: '1' },
        { key: 'Capacity', value: '100g' },
        { key: 'Shelf life (Best Before)', value: '24 Months' },
        { key: 'Hair Type', value: 'All type Of Hair' },
        { key: 'Generic Name', value: 'Cosmetics' },
        { key: 'Country of Origin', value: 'India' },
      ],
      warrantyInfo: '',
      returnPolicy: '7-day returns available.',
      customFields: [],
    },
    salePage: {
      enabled: false,
      bannerText: '',
      priorityOrder: 0,
      countdownEnd: '',
    },
  };
}

/**
 * Mount the REAL routers (the same handlers the Admin UI and storefront use)
 * on an in-process express app, then exercise POST /api/products/publish and
 * GET /api/products/slug/:slug + the private-file proxy exactly as production.
 */
async function run() {
  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(config.mongoUri, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log('✅ Connected to MongoDB');

  console.log('🔍 Verifying Backblaze object...');
  const { HeadObjectCommand } = require('@aws-sdk/client-s3');
  try {
    const head = await storage.s3.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: IMAGE_KEY }));
    console.log(`✅ Backblaze object "${IMAGE_KEY}" exists (${head.ContentLength} bytes)`);
  } catch (e) {
    throw new Error(`Backblaze object "${IMAGE_KEY}" not found: ${e.name} (${e.$metadata?.httpStatusCode || ''})`);
  }

  console.log('👤 Ensuring seed admin...');
  const admin = await ensureAdmin();
  const token = jwt.sign({ id: String(admin._id), type: 'admin' }, config.jwtSecret, { expiresIn: '1h' });

  console.log('📁 Ensuring category structure...');
  const { top, sub } = await ensureCategories();

  console.log('🛍️ Building product payload...');
  const values = buildPublishValues(top, sub);

  // Avoid duplicates: if this slug already exists, stop early (idempotent).
  const existingSlug = await mongoose.connection.db.collection('products').findOne({ slug: values.basic.slug });
  if (existingSlug) {
    console.log(`ℹ️ Product with slug "${values.basic.slug}" already exists (id: ${String(existingSlug._id)}) — skipping publish.`);
    console.log(`   Re-run only after deleting it, or edit the slug in buildPublishValues().`);
    return;
  }

  // In-process app with the real routers + required body parsing/auth.
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use('/api/products', require('../src/routes/simple-products'));
  app.use('/api/upload', require('../src/routes/simple-upload'));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  try {
    // 1) Create the product through the real admin publish route.
    console.log('🚀 POST /api/products/publish ...');
    const pubRes = await fetch(`${base}/api/products/publish`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ values }),
    });
    const pubBody = await pubRes.json();
    if (!pubRes.ok) {
      throw new Error(`Publish failed (${pubRes.status}): ${JSON.stringify(pubBody)}`);
    }
    const productId = String(pubBody.id);
    console.log(`✅ Product created — id: ${productId}`);

    // 2) Fetch the product back through the real public route.
    const slug = values.basic.slug;
    const getRes = await fetch(`${base}/api/products/slug/${slug}`);
    const product = await getRes.json();
    const image = String(product?.image || '');
    console.log(`✅ Product fetched — name: ${product?.name}`);
    console.log(`   slug: ${product?.slug}`);
    console.log(`   price: ₹${product?.price}`);
    console.log(`   category: ${product?.category} / sub: ${product?.subCategoryId || values.basic.subCategoryId}`);
    console.log(`   image: ${image}`);

    if (!image.includes('/api/upload/file/')) {
      throw new Error(`Product image did not resolve to the private proxy URL: ${image}`);
    }

    // 3) Follow the private-file proxy: expect 302 -> presigned B2 URL.
    const proxyPath = image.replace(/^https?:\/\/[^/]+/, '');
    const proxyRes = await fetch(`${base}${proxyPath}`, { redirect: 'manual' });
    const location = String(proxyRes.headers.get('location') || '');
    console.log(`✅ Private proxy -> ${proxyRes.status} ${proxyRes.status === 302 ? '(redirects to fresh presigned URL)' : ''}`);

    if (proxyRes.status !== 302 || !location.startsWith('https://')) {
      throw new Error(`Proxy did not produce a presigned redirect (status ${proxyRes.status})`);
    }

    // 4) Actually load the image bytes from the presigned URL (private bucket,
    //    so this only works with a valid signature).
    const imgRes = await fetch(location);
    if (imgRes.status !== 200) {
      throw new Error(`Presigned download failed (${imgRes.status})`);
    }
    const buf = Buffer.from(await imgRes.arrayBuffer());
    console.log(`✅ Presigned download OK — ${buf.length} bytes, content-type ${imgRes.headers.get('content-type')}`);

    // 5) Idempotency: running again must not duplicate the product.
    const dupRes = await fetch(`${base}/api/products/slug/${slug}`);
    const dup = await dupRes.json();
    console.log(`✅ Idempotency check — product still unique by slug (id: ${dup?.id || productId})`);

    console.log('');
    console.log('=== SEED SUMMARY ===');
    console.log(`Product ID : ${productId}`);
    console.log(`Product slug: ${slug}`);
    console.log(`Product name: ${values.basic.name}`);
    console.log(`Price       : ₹${values.pricing.sellingPrice}`);
    console.log(`Category    : ${top.name} → ${sub.name}`);
    console.log(`Image key   : ${IMAGE_KEY}`);
    console.log(`Image proxy : ${image}`);
    console.log('Bucket is PRIVATE (unsigned GET rejected, presigned GET works).');
    console.log('No credentials or signed URLs printed.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
  }
}

run()
  .then(() => {
    console.log('✅ Seed script completed.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ Seed failed:', err.message || err);
    process.exit(1);
  });
