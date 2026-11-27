const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { authenticateAdmin, requireAdmin } = require('../middleware/adminAuth');
const { resolveAssetUrl } = require('../config/storage');
const slugService = require('../services/productSlugService');

function sendSlugError(res, error) {
    return res.status(error.statusCode || 400).json({
        success: false,
        code: error.code || 'SLUG_INVALID',
        message: error.message,
        ...(error.suggestions ? { suggestions: error.suggestions } : {}),
        ...(error.ownerName ? { ownerName: error.ownerName } : {}),
    });
}

function mapProduct(p, req) {
    return {
        _id: String(p._id),
        id: String(p._id),
        slug: p.slug,
        slugGenerationMode: p.slugGenerationMode || 'auto',
        slugUpdatedAt: p.slugUpdatedAt || null,
        visibility: p.visibility,
        name: p.name,
        sku: p.sku,
        price: p.price,
        stock: p.stock,
        status: p.status,
        image: resolveAssetUrl(req, p.image),
        galleryImages: Array.isArray(p.galleryImages)
            ? p.galleryImages.map((i) => resolveAssetUrl(req, i)).filter(Boolean)
            : p.galleryImages,
        category: p.category,
        description: p.description,
        featured: p.featured,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        sizes: p.sizes,
        colors: p.colors,
        colorVariants: Array.isArray(p.colorVariants)
            ? p.colorVariants.map((v) => ({
                ...v,
                images: Array.isArray(v?.images)
                    ? v.images.map((i) => resolveAssetUrl(req, i)).filter(Boolean)
                    : v?.images,
            }))
            : p.colorVariants,
        variants: p.variants,
        tags: p.tags,
        keyFeatures: p.keyFeatures,
        warranty: p.warranty,
        warrantyDetails: p.warrantyDetails,
        saleEnabled: p.saleEnabled,
        saleDiscount: p.saleDiscount,
        saleStartDate: p.saleStartDate,
        saleEndDate: p.saleEndDate,
        metaTitle: p.metaTitle,
        metaDescription: p.metaDescription,
        weight: p.weight,
        dimensions: p.dimensions,
        badge: p.badge,
        brand: p.brand,
    };
}

// GET /api/admin/products - Get all products
router.get('/', authenticateAdmin, requireAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 10, search, category } = req.query;
        const db = mongoose.connection.db;

        // Build filter
        const filter = {};
        if (category) {
            filter.category = category;
        }

        if (search) {
            const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            filter.$or = [
                { name: rx },
                { description: rx },
                { sku: rx },
                { brand: rx }
            ];
        }

        // Pagination
        const pageNum = parseInt(page);
        const limitNum = Math.min(100, parseInt(limit));
        const skip = (pageNum - 1) * limitNum;

        // Projection — the admin grid needs top-level fields only; never the
        // management blob / reviews / questions for a grid listing.
        const ADMIN_PROJECTION = {
            _id: 1, slug: 1, visibility: 1, name: 1, sku: 1, price: 1, stock: 1, status: 1,
            image: 1, galleryImages: 1, category: 1, description: 1, featured: 1,
            createdAt: 1, updatedAt: 1, sizes: 1, colors: 1, colorVariants: 1, variants: 1,
            tags: 1, keyFeatures: 1, warranty: 1, warrantyDetails: 1, saleEnabled: 1,
            saleDiscount: 1, saleStartDate: 1, saleEndDate: 1, metaTitle: 1, metaDescription: 1,
            weight: 1, dimensions: 1, badge: 1, brand: 1,
        };

        const [products, total] = await Promise.all([
            db.collection('products').find(filter, { projection: ADMIN_PROJECTION }).sort({ createdAt: -1 }).skip(skip).limit(limitNum).toArray(),
            db.collection('products').countDocuments(filter)
        ]);

        const mappedProducts = products.map((p) => mapProduct(p, req));

        res.json({
            success: true,
            products: mappedProducts,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total: total,
                pages: Math.ceil(total / limitNum)
            }
        });
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch products'
        });
    }
});

// GET /api/admin/products/slug/check?slug=...&excludeId=... - Slug availability
router.get('/slug/check', authenticateAdmin, requireAdmin, async (req, res) => {
    try {
        const db = mongoose.connection.db;
        const slug = String(req.query.slug || '').trim();
        const excludeId = String(req.query.excludeId || '').trim() || undefined;
        if (!slug) {
            return res.status(400).json({ success: false, code: 'SLUG_REQUIRED', message: 'Please enter a valid product URL slug.' });
        }
        const result = await slugService.checkSlugAvailability(db, slug, excludeId);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('Error checking slug availability:', error);
        res.status(500).json({ success: false, message: 'Failed to check slug availability' });
    }
});

// GET /api/admin/products/slug/suggestions?name=...&excludeId=... - Meaningful alternatives
router.get('/slug/suggestions', authenticateAdmin, requireAdmin, async (req, res) => {
    try {
        const db = mongoose.connection.db;
        const name = String(req.query.name || '').trim();
        const excludeId = String(req.query.excludeId || '').trim() || undefined;
        if (!name) {
            return res.status(400).json({ success: false, message: 'Product name is required' });
        }
        const suggestions = await slugService.suggestSlugs(db, name, excludeId);
        res.json({ success: true, suggestions });
    } catch (error) {
        console.error('Error generating slug suggestions:', error);
        res.status(500).json({ success: false, message: 'Failed to generate slug suggestions' });
    }
});

// GET /api/admin/products/:id - Get single product
router.get('/:id', authenticateAdmin, requireAdmin, async (req, res) => {
    try {
        const db = mongoose.connection.db;
        const { ObjectId } = require('mongodb');

        const product = await db.collection('products').findOne({ _id: new ObjectId(req.params.id) });

        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        res.json({
            success: true,
            product: mapProduct(product, req)
        });
    } catch (error) {
        console.error('Error fetching product:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch product'
        });
    }
});

// POST /api/admin/products - Create new product
router.post('/', authenticateAdmin, requireAdmin, async (req, res) => {
    try {
        const productData = req.body;
        const db = mongoose.connection.db;

        // Centralized slug resolution: auto (first 3 name words) or validated
        // custom slug, globally unique, reserved routes rejected.
        const slugResolution = await slugService.resolveProductSlug({
            db,
            name: productData.name,
            requestedSlug: productData.slug,
            mode: productData.slugGenerationMode,
        });

        const newProduct = {
            ...productData,
            slug: slugResolution.slug,
            slugGenerationMode: slugResolution.mode,
            slugUpdatedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date()
        };

        const result = await db.collection('products').insertOne(newProduct);

        res.status(201).json({
            success: true,
            message: 'Product created successfully',
            product: mapProduct({ ...newProduct, _id: result.insertedId }, req)
        });
    } catch (error) {
        if (error instanceof slugService.SlugError) return sendSlugError(res, error);
        if (error && error.code === 11000) {
            return res.status(409).json({
                success: false,
                code: 'SLUG_ALREADY_EXISTS',
                message: 'This product URL is already in use. Choose a different slug.',
            });
        }
        console.error('Error creating product:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create product'
        });
    }
});

// PUT /api/admin/products/:id - Update product
router.put('/:id', authenticateAdmin, requireAdmin, async (req, res) => {
    try {
        const db = mongoose.connection.db;
        const { ObjectId } = require('mongodb');

        const existing = await db.collection('products').findOne(
            { _id: new ObjectId(req.params.id) },
            { projection: { slug: 1, name: 1 } },
        );
        if (!existing) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        const updateData = {
            ...req.body,
            updatedAt: new Date()
        };
        delete updateData.slugGenerationMode;
        delete updateData.slugUpdatedAt;

        // Slug changes go through the centralized service: format, reserved
        // routes, global uniqueness, and historical-redirect bookkeeping.
        const requestedSlug = String(req.body?.slug ?? '').trim();
        const currentSlug = String(existing.slug || '').trim();
        if (requestedSlug && requestedSlug.toLowerCase() !== currentSlug.toLowerCase()) {
            const slugResolution = await slugService.resolveProductSlug({
                db,
                name: updateData.name || existing.name,
                requestedSlug,
                mode: req.body?.slugGenerationMode,
                excludeProductId: req.params.id,
            });
            updateData.slug = slugResolution.slug;
            updateData.slugGenerationMode = slugResolution.mode;
            updateData.slugUpdatedAt = new Date();
        } else if (!requestedSlug && !currentSlug) {
            // Legacy product without a slug: generate one from the name.
            const slugResolution = await slugService.resolveProductSlug({
                db,
                name: updateData.name || existing.name,
                requestedSlug: '',
                excludeProductId: req.params.id,
            });
            updateData.slug = slugResolution.slug;
            updateData.slugGenerationMode = 'auto';
            updateData.slugUpdatedAt = new Date();
        } else {
            // Slug unchanged — still record the generation mode if provided.
            if (req.body?.slugGenerationMode === 'custom' || req.body?.slugGenerationMode === 'auto') {
                updateData.slugGenerationMode = req.body.slugGenerationMode;
            }
            delete updateData.slug;
        }

        const result = await db.collection('products').updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: updateData }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        if (updateData.slug && updateData.slug !== currentSlug) {
            await slugService.recordSlugChange(db, req.params.id, currentSlug, updateData.slug);
        }

        const updatedProduct = await db.collection('products').findOne({ _id: new ObjectId(req.params.id) });

        res.json({
            success: true,
            message: 'Product updated successfully',
            product: mapProduct(updatedProduct, req)
        });
    } catch (error) {
        if (error instanceof slugService.SlugError) return sendSlugError(res, error);
        if (error && error.code === 11000) {
            return res.status(409).json({
                success: false,
                code: 'SLUG_ALREADY_EXISTS',
                message: 'This product URL is already in use. Choose a different slug.',
            });
        }
        console.error('Error updating product:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update product'
        });
    }
});

// DELETE /api/admin/products/:id - Delete product
router.delete('/:id', authenticateAdmin, requireAdmin, async (req, res) => {
    try {
        const db = mongoose.connection.db;
        const { ObjectId } = require('mongodb');

        const existing = await db.collection('products').findOne(
            { _id: new ObjectId(req.params.id) },
            { projection: { slug: 1 } },
        );
        const result = await db.collection('products').deleteOne({ _id: new ObjectId(req.params.id) });

        if (result.deletedCount === 0) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        await slugService.tombstoneSlug(db, req.params.id, existing?.slug);

        res.json({
            success: true,
            message: 'Product deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting product:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete product'
        });
    }
});

module.exports = router;
