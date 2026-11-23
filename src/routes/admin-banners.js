const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const Banner = require('../models/banner');

const { authenticateAdmin, requireAdmin } = require('../middleware/adminAuth');
const {
    uploadObject,
    proxyPathFor,
    resolveAssetUrl,
    absoluteUrl,
    isImageUrl,
} = require('../config/storage');
const { deleteAssetIfUnreferenced } = require('../services/imageMedia');
const { processAndStoreImage } = require('../services/imageService');
const cacheService = require('../services/cacheService');
const { ApiError } = require('../lib/apiError');

/**
 * Best-effort cleanup of the B2 object(s) backing a banner image.
 * Skips the delete when the object is still referenced by a Media Library
 * `uploads` document (shared asset) or when the value is an external URL.
 */
async function cleanupBannerImage(imageValue) {
    await deleteAssetIfUnreferenced(imageValue);
}

router.use(authenticateAdmin, requireAdmin);

// POST /api/admin/banners/json - Create new banner via JSON (no multipart/form-data required)
router.post('/json', async (req, res) => {
    try {
        const { title, subtitle, link, position, active, order, image } = req.body || {};

        if (!title || !position) {
            return res.status(400).json({
                success: false,
                message: 'Title and position are required'
            });
        }

        if (!image) {
            return res.status(400).json({
                success: false,
                message: 'Image is required (provide image URL or /uploads path)'
            });
        }

        if (!isImageUrl(image)) {
            return res.status(400).json({
                success: false,
                message: 'Image must be an image URL (jpg, png, jpeg, webp, avif, gif, svg, bmp, tiff, ico) - no other file formats are allowed'
            });
        }

        const newBanner = new Banner({
            title,
            subtitle: subtitle || '',
            image: String(image),
            link: link || '',
            position,
            active: active !== undefined ? Boolean(active) : true,
            order: order !== undefined ? parseInt(order, 10) : 0,
        });

        await newBanner.save();
        invalidateCatalogCaches();

        res.status(201).json({
            success: true,
            message: 'Banner created successfully',
            banner: serializeBanner(req, newBanner)
        });
    } catch (error) {
        console.error('Error creating banner (json):', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create banner: ' + error.message
        });
    }
});

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit for banners
    },
    fileFilter: (req, file, cb) => {
        if (String(file.mimetype || '').startsWith('image/')) {
            cb(null, true);
        } else {
            // Client error (415), never a 500: the file is simply the wrong type.
            cb(
                new ApiError({
                    status: 415,
                    code: 'UNSUPPORTED_FORMAT',
                    message: 'This file type is not supported. Please choose a JPG, PNG, WebP, AVIF, GIF or SVG image.',
                })
            );
        }
    }
});

async function uploadBannerToStorage(req, file) {
    const extRaw = String(file.originalname || '').split('.').pop() || 'bin';
    const ext = String(extRaw).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'bin';

    // SVG is vector (already tiny) and must not be rasterized — store it as-is.
    if (String(file.mimetype || '').toLowerCase() === 'image/svg+xml') {
        const random = crypto.randomBytes(12).toString('hex');
        const key = `uploads/banners/${Date.now()}-${random}.${ext}`;
        await uploadObject({ key, body: file.buffer, contentType: file.mimetype });
        return { key, url: absoluteUrl(req, proxyPathFor(key)) };
    }

    // Raster banners go through the same Sharp pipeline as product images so
    // they gain immutable 320/640/1200 AVIF+WebP variants. Without this the
    // hero banner is a multi-hundred-KB original served through a 302 to B2,
    // which is the single largest LCP cost on the homepage.
    try {
        const processed = await processAndStoreImage({
            buffer: file.buffer,
            mimetype: file.mimetype,
            originalName: file.originalname,
            folder: 'banners',
            req,
        });
        return { key: processed.key, url: processed.url, variants: processed.variants };
    } catch (error) {
        // A banner must still upload if variant generation fails (e.g. exotic
        // input): fall back to the previous raw-object behaviour.
        if (error && error.statusCode === 400) throw error;
        console.error('Banner variant generation failed, falling back to original:', error?.message);
        const random = crypto.randomBytes(12).toString('hex');
        const key = `uploads/banners/${Date.now()}-${random}.${ext}`;
        await uploadObject({ key, body: file.buffer, contentType: file.mimetype });
        return { key, url: absoluteUrl(req, proxyPathFor(key)) };
    }
}

/** Drop cached catalog/banner payloads (no-op for the public HTTP cache, which is short-lived). */
function invalidateCatalogCaches() {
    try {
        cacheService.invalidateAll();
    } catch (_e) {
        /* best effort */
    }
}

// GET /api/admin/banners - Get all banners
function serializeBanner(req, banner) {
    const b = banner.toObject ? banner.toObject() : banner;
    return { ...b, image: resolveAssetUrl(req, b.image) };
}

router.get('/', async (req, res) => {
    try {
        const { position, active, grouped } = req.query;
        let filter = {};

        if (position) {
            filter.position = position;
        }

        if (active !== undefined) {
            filter.active = active === 'true';
        }

        const banners = await Banner.find(filter).sort({ order: 1, createdAt: -1 });

        const shouldGroup = grouped === 'true';

        if (shouldGroup && !position) {
            const groupedBanners = {};
            banners.forEach(banner => {
                if (!groupedBanners[banner.position]) {
                    groupedBanners[banner.position] = [];
                }
                groupedBanners[banner.position].push(serializeBanner(req, banner));
            });

            return res.json({
                success: true,
                banners: groupedBanners
            });
        }

        res.json({
            success: true,
            banners: banners.map((b) => serializeBanner(req, b))
        });
    } catch (error) {
        console.error('Error fetching banners:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch banners'
        });
    }
});

// GET /api/admin/banners/:id - Get single banner
router.get('/:id', async (req, res) => {
    try {
        const banner = await Banner.findById(req.params.id);

        if (!banner) {
            return res.status(404).json({
                success: false,
                message: 'Banner not found'
            });
        }

        res.json({
            success: true,
            banner: serializeBanner(req, banner)
        });
    } catch (error) {
        console.error('Error fetching banner:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch banner'
        });
    }
});

// POST /api/admin/banners - Create new banner with image upload
router.post('/', upload.single('image'), async (req, res, next) => {
    try {
        const { title, subtitle, link, position, active, order } = req.body;

        if (!title || !position) {
            return res.status(400).json({
                success: false,
                message: 'Title and position are required'
            });
        }

        let imageUrl = req.body.image; // For external URLs

        if (req.file) {
            const s3Obj = await uploadBannerToStorage(req, req.file);
            imageUrl = s3Obj.url;
        }

        if (!imageUrl) {
            return res.status(400).json({
                success: false,
                message: 'Image is required (either upload file or provide URL)'
            });
        }

        if (!isImageUrl(imageUrl)) {
            return res.status(400).json({
                success: false,
                message: 'Image must be an image URL (jpg, png, jpeg, webp, avif, gif, svg, bmp, tiff, ico) - no other file formats are allowed'
            });
        }

        const newBanner = new Banner({
            title,
            subtitle: subtitle || '',
            image: imageUrl,
            link: link || '',
            position,
            active: active !== undefined ? active === 'true' : true,
            order: order ? parseInt(order) : 0
        });

        await newBanner.save();
        invalidateCatalogCaches();

        res.status(201).json({
            success: true,
            message: 'Banner created successfully',
            banner: serializeBanner(req, newBanner)
        });
    } catch (error) {
        // Validation/processing failures (bad image, too large, unsupported
        // format) are client errors: let the central handler classify them.
        if (error && (error.statusCode || error.status || error.name === 'ImageValidationError')) {
            return next(error);
        }
        console.error('Error creating banner:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create banner'
        });
    }
});

// PUT /api/admin/banners/:id - Update banner
router.put('/:id', upload.single('image'), async (req, res, next) => {
    try {
        const banner = await Banner.findById(req.params.id);

        if (!banner) {
            return res.status(404).json({
                success: false,
                message: 'Banner not found'
            });
        }

        const { title, subtitle, link, position, active, order } = req.body;

        // Update fields
        if (title !== undefined) banner.title = title;
        if (subtitle !== undefined) banner.subtitle = subtitle;
        if (link !== undefined) banner.link = link;
        if (position !== undefined) banner.position = position;
        if (active !== undefined) banner.active = active === 'true';
        if (order !== undefined) banner.order = parseInt(order);

        const previousImage = banner.image;
        if (req.file) {
            const s3Obj = await uploadBannerToStorage(req, req.file);
            banner.image = s3Obj.url;
        } else if (req.body.image && req.body.image !== banner.image) {
            // If external image URL was provided
            if (!isImageUrl(req.body.image)) {
                return res.status(400).json({
                    success: false,
                    message: 'Image must be an image URL (jpg, png, jpeg, webp, avif, gif, svg, bmp, tiff, ico) - no other file formats are allowed'
                });
            }
            banner.image = req.body.image;
        }

        banner.updatedAt = new Date();
        await banner.save();
        invalidateCatalogCaches();
        if (banner.image !== previousImage) {
            await cleanupBannerImage(previousImage);
        }

        res.json({
            success: true,
            message: 'Banner updated successfully',
            banner: serializeBanner(req, banner)
        });
    } catch (error) {
        if (error && (error.statusCode || error.status || error.name === 'ImageValidationError')) {
            return next(error);
        }
        console.error('Error updating banner:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update banner'
        });
    }
});

// PUT /api/admin/banners/:id/json - Update banner via JSON (no multipart/form-data required)
router.put('/:id/json', async (req, res) => {
    try {
        const banner = await Banner.findById(req.params.id);

        if (!banner) {
            return res.status(404).json({
                success: false,
                message: 'Banner not found'
            });
        }

        const { title, subtitle, link, position, active, order, image } = req.body || {};
        const previousImage = banner.image;

        if (title !== undefined) banner.title = title;
        if (subtitle !== undefined) banner.subtitle = subtitle;
        if (link !== undefined) banner.link = link;
        if (position !== undefined) banner.position = position;
        if (active !== undefined) banner.active = Boolean(active);
        if (order !== undefined) banner.order = parseInt(order, 10);
        if (image !== undefined) {
            if (!isImageUrl(image)) {
                return res.status(400).json({
                    success: false,
                    message: 'Image must be an image URL (jpg, png, jpeg, webp, avif, gif, svg, bmp, tiff, ico) - no other file formats are allowed'
                });
            }
            banner.image = String(image);
        }

        banner.updatedAt = new Date();
        await banner.save();
        invalidateCatalogCaches();
        if (banner.image !== previousImage) {
            await cleanupBannerImage(previousImage);
        }

        res.json({
            success: true,
            message: 'Banner updated successfully',
            banner: serializeBanner(req, banner)
        });
    } catch (error) {
        console.error('Error updating banner (json):', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update banner: ' + error.message
        });
    }
});

// DELETE /api/admin/banners/:id - Delete banner
router.delete('/:id', async (req, res) => {
    try {
        const banner = await Banner.findById(req.params.id);

        if (!banner) {
            return res.status(404).json({
                success: false,
                message: 'Banner not found'
            });
        }

        const bannerImage = banner.image;
        await Banner.findByIdAndDelete(req.params.id);
        invalidateCatalogCaches();
        await cleanupBannerImage(bannerImage);

        res.json({
            success: true,
            message: 'Banner deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting banner:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete banner: ' + error.message
        });
    }
});

// PUT /api/admin/banners/:id/toggle - Toggle banner active status
router.put('/:id/toggle', async (req, res) => {
    try {
        const banner = await Banner.findById(req.params.id);

        if (!banner) {
            return res.status(404).json({
                success: false,
                message: 'Banner not found'
            });
        }

        banner.active = !banner.active;
        banner.updatedAt = new Date();
        await banner.save();
        invalidateCatalogCaches();

        res.json({
            success: true,
            message: 'Banner status updated successfully',
            banner: serializeBanner(req, banner)
        });
    } catch (error) {
        console.error('Error updating banner status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update banner status: ' + error.message
        });
    }
});

// POST /api/admin/banners/upload - Upload banner image separately
router.post('/upload', authenticateAdmin, requireAdmin, upload.single('image'), async (req, res, next) => {
    try {
        if (!req.file) {
            return next(
                new ApiError({
                    status: 400,
                    code: 'EMPTY_FILE',
                    message: 'No file was received. Please choose a file and try again.',
                })
            );
        }

        const s3Obj = await uploadBannerToStorage(req, req.file);

        res.json({
            success: true,
            message: 'Banner image uploaded successfully',
            url: s3Obj.url,
            key: s3Obj.key,
            originalname: req.file.originalname,
            size: req.file.size
        });
    } catch (error) {
        if (error && (error.statusCode || error.status || error.name === 'ImageValidationError')) {
            return next(error);
        }
        console.error('Banner upload error:', { requestId: req.id, name: error?.name, status: error?.$metadata?.httpStatusCode });
        res.status(500).json({
            success: false,
            message: 'Upload failed because the server is temporarily unavailable. Please try again.'
        });
    }
});

module.exports = router;
