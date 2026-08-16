const express = require('express');
const router = express.Router();

const { getOrCreateContentSettings } = require('../models/contentSettings');
const { resolveAssetUrl } = require('../config/storage');

router.get('/', async (req, res) => {
  try {
    const settings = await getOrCreateContentSettings();

    res.json({
      success: true,
      data: {
        brandLogoUrl: resolveAssetUrl(req, settings.brandLogoUrl),
        defaultAvatarUrl: resolveAssetUrl(req, settings.defaultAvatarUrl),
        bioMaxLength: settings.bioMaxLength,
        showOrderHistory: settings.showOrderHistory,
        showWishlistCount: settings.showWishlistCount,
        enableProfileEditing: settings.enableProfileEditing,
        enableCod: settings.enableCod,
      },
    });
  } catch (error) {
    console.error('Public content settings GET error:', error);
    res.status(500).json({ success: false, message: 'Failed to load content settings' });
  }
});

module.exports = router;
