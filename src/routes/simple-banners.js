const express = require('express');
const router = express.Router();
const Banner = require('../models/banner');
const { resolveAssetUrl } = require('../config/storage');
const { resolveMediaForValues } = require('../services/imageMedia');

// Public banners are read-only, public, and change rarely: let browsers reuse
// the payload and let shared caches serve it. This removes the API round trip
// (and the resulting image-URL discovery delay) from repeat visits, which is
// the first link in the hero LCP chain.
const PUBLIC_CACHE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600';

function setPublicCache(res) {
    res.set('Cache-Control', PUBLIC_CACHE);
    res.set('Vary', 'Accept-Encoding');
}

/**
 * Attach responsive media metadata (optimized AVIF/WebP variants + intrinsic
 * width/height) to banners in ONE batched lookups query. Banners uploaded
 * before the Sharp pipeline existed simply return `variants: null` and keep
 * their original URL, so nothing breaks.
 */
async function withMedia(req, banners) {
    if (!Array.isArray(banners) || banners.length === 0) return [];
    const media = await resolveMediaForValues(req, banners.map((b) => b.image));
    return banners.map((banner, i) => {
        const m = media[i] || {};
        const image = m.url || resolveAssetUrl(req, banner.image);
        return {
            ...banner,
            image,
            imageMedia: {
                url: image,
                variants: m.variants || null,
                width: m.width || null,
                height: m.height || null,
            },
        };
    });
}

// GET /api/banners - Get banners by position
router.get('/', async (req, res) => {
    try {
        const { position, grouped } = req.query;

        if (position) {
            // Only return fields actually used by frontend (plus `title` used
            // as the image alt text).
            const activeBanners = await Banner.find({
                position: position,
                active: true
            })
                .select('image link title _id position')
                .sort({ order: 1, createdAt: -1 })
                .lean();

            setPublicCache(res);

            if (!activeBanners || activeBanners.length === 0) {
                return res.json({
                    success: true,
                    message: 'No banners yet',
                    banners: []
                });
            }

            const banners = await withMedia(req, activeBanners);
            return res.json({
                success: true,
                banners
            });
        }

        const shouldGroup = grouped === undefined ? true : grouped === 'true';

        // If no position specified, return all active banners grouped by position
        const allBanners = await Banner.find({ active: true })
            .sort({ order: 1, createdAt: -1 })
            .lean();

        setPublicCache(res);

        if (!allBanners || allBanners.length === 0) {
            return res.json({
                success: true,
                message: 'No banners yet',
                banners: shouldGroup ? {} : []
            });
        }

        const serialized = await withMedia(req, allBanners);

        if (!shouldGroup) {
            return res.json({
                success: true,
                banners: serialized
            });
        }

        // Group banners by position
        const groupedBanners = {};
        serialized.forEach((banner) => {
            if (!groupedBanners[banner.position]) {
                groupedBanners[banner.position] = [];
            }
            groupedBanners[banner.position].push(banner);
        });

        res.json({
            success: true,
            banners: groupedBanners
        });
    } catch (error) {
        console.error('Error fetching banners:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch banners'
        });
    }
});

module.exports = router;
