const express = require('express');
const router = express.Router();
const Banner = require('../models/banner');
const { resolveAssetUrl } = require('../config/storage');

function serializeBanner(req, banner) {
    const b = banner.toObject ? banner.toObject() : banner;
    return { ...b, image: resolveAssetUrl(req, b.image) };
}

// GET /api/banners - Get banners by position
router.get('/', async (req, res) => {
    try {
        const { position, grouped } = req.query;

        if (position) {
            // Only return fields actually used by frontend: image, link, _id
            const activeBanners = await Banner.find({
                position: position,
                active: true
            }).select('image link _id').sort({ order: 1, createdAt: -1 });

            if (!activeBanners || activeBanners.length === 0) {
                return res.json({
                    success: true,
                    message: 'No banners yet',
                    banners: []
                });
            }

            return res.json({
                success: true,
                banners: activeBanners.map((b) => serializeBanner(req, b))
            });
        }

        const shouldGroup = grouped === undefined ? true : grouped === 'true';

        // If no position specified, return all active banners grouped by position
        const allBanners = await Banner.find({ active: true }).sort({ order: 1, createdAt: -1 });

        if (!allBanners || allBanners.length === 0) {
            return res.json({
                success: true,
                message: 'No banners yet',
                banners: shouldGroup ? {} : []
            });
        }

        if (!shouldGroup) {
            return res.json({
                success: true,
                banners: allBanners.map((b) => serializeBanner(req, b))
            });
        }

        // Group banners by position
        const groupedBanners = {};
        allBanners.forEach(banner => {
            const serialized = serializeBanner(req, banner);
            if (!groupedBanners[serialized.position]) {
                groupedBanners[serialized.position] = [];
            }
            groupedBanners[serialized.position].push(serialized);
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
