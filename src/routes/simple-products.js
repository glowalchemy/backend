const express = require('express');
const router = express.Router();

const mongoose = require('mongoose');
const { authenticateAdmin, requireAdmin } = require('../middleware/adminAuth');
const { CategoryModel } = require('../models/category');
const { authenticateAny } = require('../middleware/authAny');
const { ProductModel } = require('../models/product');
const { Order } = require('../models/order');
const { resolveAssetUrl, isImageUrl } = require('../config/storage');
const catalogService = require('../services/catalogService');
const cacheService = require('../services/cacheService');
const slugService = require('../services/productSlugService');
const { syncSearchProjection } = require('../services/productNormalizer');

const { mapProducts, listPublic, parseIntQuery } = catalogService;

function toAbsoluteUrl(req, url) {
    return resolveAssetUrl(req, url);
}

/**
 * Validate that every non-empty image field in a product management payload
 * is an image URL (jpg/png/jpeg/webp/avif/gif/svg/bmp/tiff/ico or an app
 * proxy path). Rejects PDFs, videos, archives and any other file format.
 */
function validateImageUrlsOrThrow(values) {
    const media = values?.media ?? {};
    const images = Array.isArray(media.images) ? media.images : [];
    const all = [
        ...images.map((i) => i?.url),
        ...((Array.isArray(values?.colorVariants) ? values.colorVariants : [])
            .flatMap((v) => (Array.isArray(v?.images) ? v.images : []))),
        values?.attributes?.sizeGuideImageUrl,
    ];
    for (const raw of all) {
        const url = String(raw ?? '').trim();
        if (!url) continue;
        if (!isImageUrl(url)) {
            const err = new Error('Only image URLs are allowed (jpg, png, jpeg, webp, avif, gif, svg, bmp, tiff, ico). No other file formats.');
            err.statusCode = 400;
            throw err;
        }
    }
}

async function validateSubCategoryOrThrow(base) {
    const categoryIds = Array.isArray(base?.categoryIds) ? base.categoryIds : [];
    const categoryId = String(categoryIds[0] ?? '').trim();
    const subCategoryId = String(base?.subCategoryId ?? '').trim();

    if (!categoryId) {
        const err = new Error('Category is required');
        err.statusCode = 400;
        throw err;
    }

    if (!subCategoryId) {
        const err = new Error('Sub Category is required');
        err.statusCode = 400;
        throw err;
    }

    const sub = await CategoryModel.findById(subCategoryId).lean();
    // parentId null => this is a top-level category, not a sub-category
    if (!sub || sub.parentId === null || String(sub.parentId) !== String(categoryId)) {
        const err = new Error('Please enter a sub category');
        err.statusCode = 400;
        throw err;
    }
}

/**
 * Enforce the required fields declared by the Product mongoose schema
 * (name, sku, originalPrice, price, stock). These writes bypass Mongoose, so
 * the contract is checked explicitly here.
 */
function validateRequiredFieldsOrThrow(base, pricing, inventory) {
    const fail = (msg) => {
        const err = new Error(msg);
        err.statusCode = 400;
        throw err;
    };
    if (!String(base?.name ?? '').trim()) fail('Product name is required');
    if (!String(inventory?.sku ?? '').trim()) fail('SKU is required');
    if (!Number.isFinite(Number(pricing?.originalPrice))) fail('Original price is required');
    if (!Number.isFinite(Number(pricing?.sellingPrice))) fail('Selling price is required');
    if (!Number.isFinite(Number(inventory?.stockQuantity))) fail('Stock quantity is required');
}

function mapStatusToCatalogStatus(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'active') return 'active';
    if (s === 'draft') return 'draft';
    return 'inactive';
}

/**
 * Resolve the authoritative slug for a product write through the centralized
 * slug service. On update, an empty submitted slug preserves the stored one;
 * a changed slug is validated for format, reserved routes and global
 * uniqueness (excluding this product) before being accepted.
 */
async function resolveSlugForWrite(db, { productId, name, requestedSlug, mode }) {
    const requested = String(requestedSlug ?? '').trim();
    const { ObjectId } = require('mongodb');

    if (productId) {
        const existing = await db.collection('products').findOne(
            { _id: new ObjectId(String(productId)) },
            { projection: { slug: 1 } },
        );
        const current = String(existing?.slug || '').trim();
        if (!requested || requested.toLowerCase() === current.toLowerCase()) {
            return { slug: current, mode: mode === 'custom' ? 'custom' : 'auto', changed: false };
        }
        const resolved = await slugService.resolveProductSlug({
            db, name, requestedSlug: requested, mode, excludeProductId: productId,
        });
        return { ...resolved, changed: resolved.slug !== current };
    }

    return slugService.resolveProductSlug({ db, name, requestedSlug: requested, mode });
}

/** Send a slug-service error with its machine-readable code intact. */
function sendSlugError(res, error) {
    return res.status(error.statusCode || 400).json({
        success: false,
        code: error.code || 'SLUG_INVALID',
        message: error.message,
        ...(error.suggestions ? { suggestions: error.suggestions } : {}),
        ...(error.ownerName ? { ownerName: error.ownerName } : {}),
    });
}

// GET /api/products/catalog (admin)
router.get('/catalog', authenticateAdmin, requireAdmin, async (req, res) => {
    try {
        const db = mongoose.connection.db;
        const docs = await db
            .collection('products')
            .find({}, { projection: { name: 1, sku: 1 } })
            .sort({ name: 1 })
            .toArray();
        res.json(docs.map((p) => ({ id: String(p._id), name: p.name ?? '', sku: p.sku ?? '' })));
    } catch (error) {
        console.error('Error fetching catalog products:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch catalog products' });
    }
});

// GET /api/products (mode=admin requires token, mode=public is open)
router.get('/', async (req, res, next) => {
    const mode = String(req.query?.mode ?? 'public');
    if (mode === 'admin') return authenticateAdmin(req, res, () => requireAdmin(req, res, next));
    return next();
});

router.get('/', async (req, res) => {
    try {
        const mode = String(req.query?.mode ?? 'public');
        const q = String(req.query?.q ?? '').trim();
        const category = String(req.query?.category ?? '').trim();
        const subCategoryId = String(req.query?.subCategoryId ?? '').trim();
        const sort = String(req.query?.sort ?? '').trim();
        const order = String(req.query?.order ?? '').trim().toLowerCase();
        const page = parseIntQuery(req.query?.page);
        const limit = parseIntQuery(req.query?.limit);
        const wantFacets = String(req.query?.facets ?? '').toLowerCase() === 'true';

        const params = {
            req,
            mode,
            q: q || undefined,
            category: category || undefined,
            subCategoryId: subCategoryId || undefined,
            minPrice: parseIntQuery(req.query?.minPrice),
            maxPrice: parseIntQuery(req.query?.maxPrice),
            inStock: String(req.query?.inStock ?? '').toLowerCase() === 'true' ? true : undefined,
            outOfStock: String(req.query?.outOfStock ?? '').toLowerCase() === 'true' ? true : undefined,
            freeShipping: String(req.query?.freeShipping ?? '').toLowerCase() === 'true' ? true : undefined,
            onSale: String(req.query?.onSale ?? '').toLowerCase() === 'true' ? true : undefined,
            featured: String(req.query?.featured ?? '').toLowerCase() === 'true' ? true : undefined,
            rating: parseIntQuery(req.query?.rating),
            sizes: catalogService.parseCsvQuery(req.query?.sizes),
            colors: catalogService.parseCsvQuery(req.query?.colors),
            brands: catalogService.parseCsvQuery(req.query?.brands),
            sort: sort || undefined,
            order,
            page,
            limit,
            wantFacets: String(req.query?.facets ?? '').toLowerCase() === 'true' ? true : false,
            fields: String(req.query?.fields || '').trim() || undefined,
        };

        const data = mode === 'public' ? await listPublic(req, params) : await catalogService.queryCatalog(params);
        const cacheable = mode === 'public';
        if (cacheable) {
            res.set('Cache-Control', 'public, max-age=15, s-maxage=15');
        } else {
            res.set('Cache-Control', 'no-store');
        }
        if (q) {
            // Include lightweight category/brand suggestions for full-search UX.
            const suggestions = await catalogService.suggestForQuery(q);
            if (Array.isArray(data)) {
                res.json(data);
                return;
            }
            return res.json({ ...data, suggestions });
        }
        res.json(data);
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch products' });
    }
});

// GET /api/products/:id/management (admin)
router.get('/:id/management', authenticateAdmin, requireAdmin, async (req, res) => {
    try {
        const db = mongoose.connection.db;
        const { ObjectId } = require('mongodb');
        const doc = await db.collection('products').findOne({ _id: new ObjectId(req.params.id) });
        if (!doc) return res.status(404).json({ success: false, message: 'Product not found' });
        // The top-level `slug` is authoritative; mirror it (and its mode)
        // into the management blob so the admin form edits the live value
        // instead of a stale copy.
        const management = doc.management && typeof doc.management === 'object' ? doc.management : {};
        res.json({
            ...management,
            basic: {
                ...(management.basic || {}),
                slug: String(doc.slug || ''),
                slugMode: doc.slugGenerationMode === 'custom' ? 'custom' : 'auto',
            },
        });
    } catch (error) {
        console.error('Error fetching product management:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch product management' });
    }
});

// GET /api/products/slug/:slug (mode=admin requires token, mode=public is open)
router.get('/slug/:slug', async (req, res, next) => {
    const mode = String(req.query?.mode ?? 'public');
    if (mode === 'admin') return authenticateAdmin(req, res, () => requireAdmin(req, res, next));
    return next();
});

router.get('/slug/:slug', async (req, res) => {
    try {
        const mode = String(req.query?.mode ?? 'public');
        const db = mongoose.connection.db;

        const filter = { slug: String(req.params.slug) };
        if (mode !== 'admin') {
            filter.status = { $in: ['active', 'published'] };
            filter.$or = [
                { visibility: 'public' },
                { visibility: { $exists: false } },
                { visibility: null },
                { 'management.basic.visibility': 'public' },
                { 'management.basic.visibility': { $exists: false } },
                { 'management.basic.visibility': null },
            ];
        }

        const doc = await db.collection('products').findOne(filter);
        if (!doc) {
            // Historical slug? Tell the client where the product lives now so
            // it can redirect (and crawlers eventually see the canonical URL).
            const moved = await slugService.findSlugRedirect(db, req.params.slug);
            if (moved && moved.redirectTo) {
                return res.status(404).json({
                    success: false,
                    code: 'SLUG_MOVED',
                    message: 'This product URL has moved.',
                    redirectTo: `/${moved.redirectTo}`,
                });
            }
            return res.status(404).json({ success: false, code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
        }
        res.json((await mapProducts(req, [doc]))[0]);
    } catch (error) {
        console.error('Error fetching product by slug:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch product' });
    }
});

router.post('/:productId/reviews', authenticateAny, async (req, res) => {
    try {
        if (!req.userId || !req.user) {
            return res.status(401).json({ success: false, message: 'Access token required' });
        }

        const productId = String(req.params.productId || '').trim();
        if (!mongoose.Types.ObjectId.isValid(productId)) {
            return res.status(400).json({ success: false, message: 'Invalid product id' });
        }

        const rating = Number(req.body?.rating);
        const title = String(req.body?.title || '').trim();
        const comment = String(req.body?.comment || '').trim();
        const imagesRaw = Array.isArray(req.body?.images) ? req.body.images : [];
        const images = imagesRaw
            .map((u) => String(u || '').trim())
            .filter((u) => u.length > 0)
            .slice(0, 5);

        for (const u of images) {
            if (!isImageUrl(u)) {
                return res.status(400).json({ success: false, message: 'Review images must be image URLs only (no other file formats)' });
            }
        }

        if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
            return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5' });
        }
        if (!title) return res.status(400).json({ success: false, message: 'Title is required' });
        if (!comment) return res.status(400).json({ success: false, message: 'Comment is required' });

        const userId = new mongoose.Types.ObjectId(String(req.userId));
        const email = String(req.user?.email || '').trim().toLowerCase();
        const name = String(req.user?.name || '').trim() || 'Customer';

        const hasDelivered = await Order.exists({
            user: userId,
            status: 'delivered',
            items: { $elemMatch: { productId: String(productId) } },
        });
        if (!hasDelivered) {
            return res.status(403).json({ success: false, message: 'You can review only after delivery' });
        }

        const product = await ProductModel.findById(productId);
        if (!product) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }

        const already = (Array.isArray(product.reviews) ? product.reviews : []).some((r) => String(r?.customerEmail || '').toLowerCase() === email);
        if (already) {
            return res.status(409).json({ success: false, message: 'You have already reviewed this product' });
        }

        const nowIso = new Date().toISOString();
        product.reviews.push({
            rating: Math.round(rating),
            title,
            comment,
            customerName: name,
            customerEmail: email,
            images,
            date: nowIso,
            verifiedPurchase: true,
            helpful: 0,
            status: 'pending',
        });

        const approved = (product.reviews || []).filter((r) => String(r?.status || '') === 'approved');
        const avg = approved.length
            ? approved.reduce((sum, r) => sum + Number(r?.rating || 0), 0) / approved.length
            : 0;
        product.rating = Math.round(avg * 10) / 10;
        await product.save();
        cacheService.invalidateAll();

        const created = product.reviews[product.reviews.length - 1];
        return res.status(201).json({
            success: true,
            message: 'Review submitted successfully',
            data: {
                id: String(created?._id || ''),
                status: String(created?.status || 'pending'),
            },
        });
    } catch (error) {
        console.error('Error submitting product review:', error);
        return res.status(500).json({ success: false, message: 'Failed to submit review' });
    }
});

// POST /api/products/draft (admin)
router.post('/draft', authenticateAdmin, requireAdmin, async (req, res) => {
    try {
        const db = mongoose.connection.db;
        const { ObjectId } = require('mongodb');
        const id = req.body?.id;
        const values = req.body?.values;
        if (!values) return res.status(400).json({ success: false, message: 'Missing values' });

        const now = new Date();
        const base = values?.basic ?? {};
        await validateSubCategoryOrThrow(base);
        validateImageUrlsOrThrow(values);
        const pricing = values?.pricing ?? {};
        const inventory = values?.inventory ?? {};
        const media = values?.media ?? {};
        const shipping = values?.shipping ?? {};
        const dimensions = shipping?.dimensionsCm ?? { length: 0, width: 0, height: 0 };
        validateRequiredFieldsOrThrow(base, pricing, inventory);

        const images = Array.isArray(media?.images) ? media.images : [];
        const thumbId = media?.thumbnailId ?? null;
        const thumb = thumbId ? images.find((i) => i?.id === thumbId) : null;
        const primaryImageUrl = String((thumb?.url ?? images[0]?.url ?? '') || '');
        const galleryImages = images
            .map((i) => i?.url)
            .filter((u) => typeof u === 'string' && u.trim().length)
            .map((u) => String(u));

        const categoryIds = Array.isArray(base?.categoryIds) ? base.categoryIds : [];
        const category = String(categoryIds[0] ?? '');

        const slugResolution = await resolveSlugForWrite(db, {
            productId: id || null,
            name: base.name,
            requestedSlug: base.slug,
            mode: base.slugMode,
        });

        // Keep the management blob's slug fields in sync with the resolved
        // top-level slug so the admin form always edits the live value.
        const managementValues = {
            ...values,
            basic: { ...base, slug: slugResolution.slug, slugMode: slugResolution.mode },
        };

        const doc = {
            slug: slugResolution.slug,
            slugGenerationMode: slugResolution.mode,
            visibility: base.visibility,
            name: base.name,
            sku: inventory.sku,
            originalPrice: Number(pricing.originalPrice) || 0,
            price: pricing.sellingPrice,
            stock: inventory.stockQuantity,
            status: 'draft',
            image: primaryImageUrl,
            galleryImages,
            category,
            description: base.shortDescription ?? '',
            featured: !!(values?.marketing?.featured),
            freeShipping: !!shipping.freeShipping,
            codAvailable: !!shipping.codAvailable,
            codCharge: Number(shipping.codCharge ?? 0) || 0,
            shippingCharge: Number(shipping.shippingCharge ?? 0) || 0,
            weight: Number(shipping.weightKg ?? 0) || 0,
            dimensions,
            management: managementValues,
            createdAt: now,
            updatedAt: now,
        };

        if (id) {
            const previous = await db.collection('products').findOne(
                { _id: new ObjectId(id) },
                { projection: { slug: 1 } },
            );
            const updateDoc = { ...doc, updatedAt: now };
            if (slugResolution.changed) updateDoc.slugUpdatedAt = now;
            await db.collection('products').updateOne({ _id: new ObjectId(id) }, { $set: updateDoc });
            if (slugResolution.changed) {
                await slugService.recordSlugChange(db, id, previous?.slug, slugResolution.slug);
            }
            cacheService.invalidateAll();
            return res.json({ id: String(id), slug: slugResolution.slug });
        }

        const result = await db.collection('products').insertOne({ ...doc, slugUpdatedAt: now });
        cacheService.invalidateAll();
        res.json({ id: String(result.insertedId), slug: slugResolution.slug });
    } catch (error) {
        if (error instanceof slugService.SlugError) return sendSlugError(res, error);
        if (error && error.code === 11000 && error.keyPattern && error.keyPattern.slug) {
            return res.status(409).json({
                success: false,
                code: 'SLUG_ALREADY_EXISTS',
                message: 'This product URL is already in use. Choose a different slug.',
            });
        }
        if (error && error.statusCode) {
            return res.status(error.statusCode).json({ success: false, message: error.message });
        }
        console.error('Error saving draft:', error);
        res.status(500).json({ success: false, message: 'Failed to save draft' });
    }
});

// POST /api/products/publish (admin)
router.post('/publish', authenticateAdmin, requireAdmin, async (req, res) => {
    try {
        const db = mongoose.connection.db;
        const { ObjectId } = require('mongodb');
        const id = req.body?.id;
        const values = req.body?.values;
        if (!values) return res.status(400).json({ success: false, message: 'Missing values' });

        const now = new Date();
        const base = values?.basic ?? {};
        await validateSubCategoryOrThrow(base);
        validateImageUrlsOrThrow(values);
        const pricing = values?.pricing ?? {};
        const inventory = values?.inventory ?? {};
        validateRequiredFieldsOrThrow(base, pricing, inventory);

        const media = values?.media ?? {};
        const shipping = values?.shipping ?? {};
        const dimensions = shipping?.dimensionsCm ?? { length: 0, width: 0, height: 0 };

        const images = Array.isArray(media?.images) ? media.images : [];
        const thumbId = media?.thumbnailId ?? null;
        const thumb = thumbId ? images.find((i) => i?.id === thumbId) : null;
        const primaryImageUrl = String((thumb?.url ?? images[0]?.url ?? '') || '');
        const galleryImages = images
            .map((i) => i?.url)
            .filter((u) => typeof u === 'string' && u.trim().length)
            .map((u) => String(u));

        const categoryIds = Array.isArray(base?.categoryIds) ? base.categoryIds : [];
        const category = String(categoryIds[0] ?? '');

        const slugResolution = await resolveSlugForWrite(db, {
            productId: id || null,
            name: base.name,
            requestedSlug: base.slug,
            mode: base.slugMode,
        });

        const managementValues = {
            ...values,
            basic: { ...base, slug: slugResolution.slug, slugMode: slugResolution.mode },
        };

        const doc = {
            slug: slugResolution.slug,
            slugGenerationMode: slugResolution.mode,
            visibility: base.visibility,
            name: base.name,
            sku: inventory.sku,
            originalPrice: Number(pricing.originalPrice) || 0,
            price: pricing.sellingPrice,
            stock: inventory.stockQuantity,
            status: 'active',
            image: primaryImageUrl,
            galleryImages,
            category,
            description: base.shortDescription ?? '',
            featured: !!(values?.marketing?.featured),
            freeShipping: !!shipping.freeShipping,
            codAvailable: !!shipping.codAvailable,
            codCharge: Number(shipping.codCharge ?? 0) || 0,
            shippingCharge: Number(shipping.shippingCharge ?? 0) || 0,
            weight: Number(shipping.weightKg ?? 0) || 0,
            dimensions,
            management: managementValues,
            updatedAt: now,
        };

        if (id) {
            const previous = await db.collection('products').findOne(
                { _id: new ObjectId(id) },
                { projection: { slug: 1 } },
            );
            const updateDoc = { ...doc };
            if (slugResolution.changed) updateDoc.slugUpdatedAt = now;
            await db.collection('products').updateOne({ _id: new ObjectId(id) }, { $set: updateDoc });
            const updated = await db.collection('products').findOne({ _id: new ObjectId(id) });
            if (updated) syncSearchProjection(updated);
            if (slugResolution.changed) {
                await slugService.recordSlugChange(db, id, previous?.slug, slugResolution.slug);
            }
            cacheService.invalidateAll();
            return res.json({ id: String(id), slug: slugResolution.slug });
        }

        const created = { ...doc, createdAt: now, slugUpdatedAt: now };
        const result = await db.collection('products').insertOne(created);
        syncSearchProjection({ ...created, _id: result.insertedId });
        cacheService.invalidateAll();
        res.json({ id: String(result.insertedId), slug: slugResolution.slug });
    } catch (error) {
        if (error instanceof slugService.SlugError) return sendSlugError(res, error);
        if (error && error.code === 11000 && error.keyPattern && error.keyPattern.slug) {
            return res.status(409).json({
                success: false,
                code: 'SLUG_ALREADY_EXISTS',
                message: 'This product URL is already in use. Choose a different slug.',
            });
        }
        if (error && error.statusCode) {
            return res.status(error.statusCode).json({ success: false, message: error.message });
        }
        console.error('Error publishing product:', error);
        res.status(500).json({ success: false, message: 'Failed to publish product' });
    }
});

// PUT /api/products/:id (admin)
router.put('/:id', authenticateAdmin, requireAdmin, async (req, res) => {
    try {
        const db = mongoose.connection.db;
        const { ObjectId } = require('mongodb');
        const values = req.body?.values;
        if (!values) return res.status(400).json({ success: false, message: 'Missing values' });

        const now = new Date();
        const base = values?.basic ?? {};
        await validateSubCategoryOrThrow(base);
        validateImageUrlsOrThrow(values);
        const pricing = values?.pricing ?? {};
        const inventory = values?.inventory ?? {};
        const media = values?.media ?? {};
        const shipping = values?.shipping ?? {};
        const dimensions = shipping?.dimensionsCm ?? { length: 0, width: 0, height: 0 };
        validateRequiredFieldsOrThrow(base, pricing, inventory);

        const images = Array.isArray(media?.images) ? media.images : [];
        const thumbId = media?.thumbnailId ?? null;
        const thumb = thumbId ? images.find((i) => i?.id === thumbId) : null;
        const primaryImageUrl = String((thumb?.url ?? images[0]?.url ?? '') || '');
        const galleryImages = images
            .map((i) => i?.url)
            .filter((u) => typeof u === 'string' && u.trim().length)
            .map((u) => String(u));

        const categoryIds = Array.isArray(base?.categoryIds) ? base.categoryIds : [];
        const category = String(categoryIds[0] ?? '');

        const nextStatus = mapStatusToCatalogStatus(base?.status);
        const nextVisibility = String(base?.visibility || 'public');
        const nextName = String(base?.name || '').trim();
        const nextSku = String(inventory?.sku || '').trim();
        const nextOriginalPrice = Number(pricing?.originalPrice ?? NaN);
        const nextPrice = Number(pricing?.sellingPrice ?? NaN);
        const nextStock = Number(inventory?.stockQuantity ?? NaN);
        const nextDescription = typeof base?.shortDescription === 'string' ? base.shortDescription : '';

        const slugResolution = await resolveSlugForWrite(db, {
            productId: req.params.id,
            name: nextName || undefined,
            requestedSlug: base?.slug,
            mode: base?.slugMode,
        });

        const managementValues = {
            ...values,
            basic: { ...base, slug: slugResolution.slug, slugMode: slugResolution.mode },
        };

        const previous = await db.collection('products').findOne(
            { _id: new ObjectId(req.params.id) },
            { projection: { slug: 1, name: 1 } },
        );
        if (!previous) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }

        const slugUpdate = {};
        if (slugResolution.changed) {
            slugUpdate.slug = slugResolution.slug;
            slugUpdate.slugGenerationMode = slugResolution.mode;
            slugUpdate.slugUpdatedAt = now;
        }

        await db.collection('products').updateOne(
            { _id: new ObjectId(req.params.id) },
            {
                $set: {
                    management: managementValues,
                    status: nextStatus,
                    visibility: nextVisibility,
                    ...(nextName ? { name: nextName } : {}),
                    ...slugUpdate,
                    ...(nextSku ? { sku: nextSku } : {}),
                    ...(Number.isFinite(nextOriginalPrice) ? { originalPrice: nextOriginalPrice } : {}),
                    ...(Number.isFinite(nextPrice) ? { price: nextPrice } : {}),
                    ...(Number.isFinite(nextStock) ? { stock: nextStock } : {}),
                    description: nextDescription,
                    image: primaryImageUrl,
                    galleryImages,
                    category,
                    freeShipping: !!shipping.freeShipping,
                    codAvailable: !!shipping.codAvailable,
                    codCharge: Number(shipping.codCharge ?? 0) || 0,
                    shippingCharge: Number(shipping.shippingCharge ?? 0) || 0,
                    weight: Number(shipping.weightKg ?? 0) || 0,
                    dimensions,
                    updatedAt: now,
                },
            }
        );
        const updated = await db.collection('products').findOne({ _id: new ObjectId(req.params.id) });
        if (updated) syncSearchProjection(updated);
        if (slugResolution.changed) {
            await slugService.recordSlugChange(db, req.params.id, previous?.slug, slugResolution.slug);
        }
        cacheService.invalidateAll();
        res.json({ id: req.params.id, slug: slugResolution.slug });
    } catch (error) {
        if (error instanceof slugService.SlugError) return sendSlugError(res, error);
        if (error && error.code === 11000 && error.keyPattern && error.keyPattern.slug) {
            return res.status(409).json({
                success: false,
                code: 'SLUG_ALREADY_EXISTS',
                message: 'This product URL is already in use. Choose a different slug.',
            });
        }
        if (error && error.statusCode) {
            return res.status(error.statusCode).json({ success: false, message: error.message });
        }
        console.error('Error updating product:', error);
        res.status(500).json({ success: false, message: 'Failed to update product' });
    }
});

// DELETE /api/products/:id (admin)
router.delete('/:id', authenticateAdmin, requireAdmin, async (req, res) => {
    try {
        const db = mongoose.connection.db;
        const { ObjectId } = require('mongodb');
        const existing = await db.collection('products').findOne(
            { _id: new ObjectId(req.params.id) },
            { projection: { slug: 1 } },
        );
        const result = await db.collection('products').deleteOne({ _id: new ObjectId(req.params.id) });
        if (!result.deletedCount) return res.status(404).json({ success: false, message: 'Product not found' });
        // Keep the slug reserved so a deleted product's URL can never be
        // recycled by an unrelated product (SEO stability).
        await slugService.tombstoneSlug(db, req.params.id, existing?.slug);
        cacheService.invalidateAll();
        res.json({ ok: true });
    } catch (error) {
        console.error('Error deleting product:', error);
        res.status(500).json({ success: false, message: 'Failed to delete product' });
    }
});

// GET /api/products/popular - Sales-based popular products
// MUST be defined before /:id to avoid route conflict
router.get('/popular', async (req, res) => {
    try {
        const limit = Math.min(100, Math.max(1, Number(req.query?.limit || 60) || 60));
        const products = await catalogService.getPopularProducts(req, { limit });
        res.json(products);
    } catch (error) {
        console.error('Error fetching popular products:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch popular products' });
    }
});

// GET /api/products/:id (mode=admin requires token, mode=public is open)
router.get('/:id', async (req, res, next) => {
    const mode = String(req.query?.mode ?? 'public');
    if (mode === 'admin') return authenticateAdmin(req, res, () => requireAdmin(req, res, next));
    return next();
});

router.get('/:id', async (req, res) => {
    try {
        const mode = String(req.query?.mode ?? 'public');
        const db = mongoose.connection.db;
        const { ObjectId } = require('mongodb');

        // Validate ObjectId format before creating instance
        const id = req.params.id;
        if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
            return res.status(400).json({ success: false, message: 'Invalid product ID format' });
        }

        const filter = { _id: new ObjectId(id) };
        if (mode !== 'admin') {
            filter.status = { $in: ['active', 'published'] };
            filter.$or = [
                { visibility: 'public' },
                { visibility: { $exists: false } },
                { visibility: null },
                { 'management.basic.visibility': 'public' },
                { 'management.basic.visibility': { $exists: false } },
                { 'management.basic.visibility': null },
            ];
        }

        const doc = await db.collection('products').findOne(filter);
        if (!doc) return res.status(404).json({ success: false, message: 'Product not found' });
        res.json((await mapProducts(req, [doc]))[0]);
    } catch (error) {
        console.error('Error fetching product:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch product' });
    }
});

module.exports = router;
