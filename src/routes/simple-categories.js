const express = require('express');
const router = express.Router();

const { CategoryModel } = require('../models/category');
const { ProductModel } = require('../models/product');
const { authenticateAdmin, requireAdmin } = require('../middleware/adminAuth');
const catalogService = require('../services/catalogService');
const cacheService = require('../services/cacheService');

// GET /api/categories - Get all categories
router.get('/', async (req, res) => {
    try {
        const mode = String(req.query?.mode ?? 'admin');
        const parentId = typeof req.query?.parentId === 'string' ? req.query.parentId : undefined;
        const filter = parentId !== undefined ? { parentId } : {};
        if (mode === 'public') {
            filter.active = true;
        }

        // ONE aggregation for all category/subcategory counts with the SAME
        // visibility semantics as the listing (active+published + public
        // visibility) — replaces the previous N+1 countDocuments pattern.
        const cacheKey = `categories|${mode}|${parentId || 'all'}`;
        const run = async () => {
            const categories = await CategoryModel.find(filter).sort({ order: 1 }).lean();
            const { countById, countBySub } = mode === 'public'
                ? await catalogService.computeCategoryCounts('public')
                : { countById: new Map(), countBySub: new Map() };
            return {
                categories,
                countById,
                countBySub,
            };
        };

        let categories;
        let countById;
        let countBySub;
        if (mode === 'public') {
            const hit = await cacheService.getOrSet(cacheKey, run);
            categories = hit.value.categories;
            countById = hit.value.countById;
            countBySub = hit.value.countBySub;
        } else {
            const result = await run();
            categories = result.categories;
            countById = result.countById;
            countBySub = result.countBySub;
        }

        if (mode === 'public') {
            res.set('Cache-Control', 'public, max-age=15, s-maxage=15');
        } else {
            res.set('Cache-Control', 'no-store');
        }

        res.json(
            categories.map((c) => ({
                id: String(c._id),
                name: c.name,
                shortDescription: c.shortDescription,
                description: c.description,
                parentId: c.parentId,
                order: c.order,
                active: c.active,
                productCount: countById.get(String(c._id)) ?? c.productCount ?? 0,
                subProductCount: countBySub.get(String(c._id)) ?? 0,
                imageUrl: c.imageUrl,
            }))
        );
    } catch (error) {
        console.error('Failed to fetch categories:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch categories' });
    }
});

// GET /api/categories/:id - Get single category
router.get('/:id', async (req, res) => {
    try {
        const category = await CategoryModel.findById(req.params.id).lean();
        if (!category) {
            return res.status(404).json({ success: false, message: 'Category not found' });
        }

        res.json({
            id: String(category._id),
            name: category.name,
            shortDescription: category.shortDescription,
            description: category.description,
            parentId: category.parentId,
            order: category.order,
            active: category.active,
            productCount: category.productCount,
            imageUrl: category.imageUrl,
        });
    } catch (error) {
        console.error('Failed to fetch category:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch category' });
    }
});

router.post('/', authenticateAdmin, requireAdmin, async (req, res) => {
    try {
        const name = String(req.body?.name ?? '').trim();
        if (!name) return res.status(400).json({ success: false, message: 'Name is required' });

        const created = await CategoryModel.create({
            name,
            shortDescription: String(req.body?.shortDescription ?? ''),
            description: String(req.body?.description ?? ''),
            parentId: req.body?.parentId ?? null,
            order: Number.isFinite(req.body?.order) ? req.body.order : Number(req.body?.order ?? 0),
            active: typeof req.body?.active === 'boolean' ? req.body.active : req.body?.active !== 'false',
            imageUrl: String(req.body?.imageUrl ?? ''),
            productCount: 0,
        });

        cacheService.invalidateAll();
        res.status(201).json({
            id: String(created._id),
            name: created.name,
            shortDescription: created.shortDescription,
            description: created.description,
            parentId: created.parentId,
            order: created.order,
            active: created.active,
            productCount: created.productCount,
            imageUrl: created.imageUrl,
        });
    } catch (error) {
        console.error('Failed to create category:', error);
        res.status(500).json({ success: false, message: 'Failed to create category' });
    }
});

router.put('/:id', authenticateAdmin, requireAdmin, async (req, res) => {
    try {
        const name = String(req.body?.name ?? '').trim();
        if (!name) return res.status(400).json({ success: false, message: 'Name is required' });

        const updated = await CategoryModel.findByIdAndUpdate(
            req.params.id,
            {
                name,
                shortDescription: String(req.body?.shortDescription ?? ''),
                description: String(req.body?.description ?? ''),
                parentId: req.body?.parentId ?? null,
                order: Number.isFinite(req.body?.order) ? req.body.order : Number(req.body?.order ?? 0),
                active: typeof req.body?.active === 'boolean' ? req.body.active : req.body?.active !== 'false',
                imageUrl: String(req.body?.imageUrl ?? ''),
            },
            { new: true }
        ).lean();

        if (!updated) return res.status(404).json({ success: false, message: 'Category not found' });

        cacheService.invalidateAll();
        res.json({
            id: String(updated._id),
            name: updated.name,
            shortDescription: updated.shortDescription,
            description: updated.description,
            parentId: updated.parentId,
            order: updated.order,
            active: updated.active,
            productCount: updated.productCount,
            imageUrl: updated.imageUrl,
        });
    } catch (error) {
        console.error('Failed to update category:', error);
        res.status(500).json({ success: false, message: 'Failed to update category' });
    }
});

router.delete('/:id', authenticateAdmin, requireAdmin, async (req, res) => {
    try {
        const child = await CategoryModel.findOne({ parentId: req.params.id }).lean();
        if (child) return res.status(400).json({ success: false, message: 'Cannot delete a category that has children' });

        const deleted = await CategoryModel.findByIdAndDelete(req.params.id).lean();
        if (!deleted) return res.status(404).json({ success: false, message: 'Category not found' });

        cacheService.invalidateAll();
        res.json({ ok: true });
    } catch (error) {
        console.error('Failed to delete category:', error);
        res.status(500).json({ success: false, message: 'Failed to delete category' });
    }
});

module.exports = router;
