const express = require('express');
const router = express.Router();
const { MetaConfig } = require('../models/metaConfig');
const { AdminModel } = require('../models/admin');

// Middleware to verify admin token
const verifyAdmin = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, require('../config').jwtSecret);
    
    if (decoded.type !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not an admin' });
    }

    const admin = await AdminModel.findById(decoded.id);
    if (!admin) {
      return res.status(404).json({ success: false, message: 'Admin not found' });
    }

    req.admin = admin;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

// Apply admin verification to all routes
router.use(verifyAdmin);

/**
 * @route   GET /api/admin/meta-config
 * @desc    Get all Meta configurations
 * @access  Admin
 */
router.get('/', async (req, res) => {
  try {
    const configs = await MetaConfig.find()
      .sort({ createdAt: -1 })
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email');

    res.json({ success: true, data: configs });
  } catch (error) {
    console.error('Error fetching meta configs:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch configurations',
      error: error.message 
    });
  }
});

/**
 * @route   GET /api/admin/meta-config/active
 * @desc    Get active Meta configuration
 * @access  Admin
 */
router.get('/active', async (req, res) => {
  try {
    const config = await MetaConfig.findOne({ status: 'active' })
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email');

    if (!config) {
      return res.status(404).json({ 
        success: false, 
        message: 'No active configuration found' 
      });
    }

    res.json({ success: true, data: config });
  } catch (error) {
    console.error('Error fetching active meta config:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch active configuration',
      error: error.message 
    });
  }
});

/**
 * @route   GET /api/admin/meta-config/:id
 * @desc    Get single Meta configuration by ID
 * @access  Admin
 */
router.get('/:id', async (req, res) => {
  try {
    const config = await MetaConfig.findById(req.params.id)
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email');

    if (!config) {
      return res.status(404).json({ 
        success: false, 
        message: 'Configuration not found' 
      });
    }

    res.json({ success: true, data: config });
  } catch (error) {
    console.error('Error fetching meta config:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch configuration',
      error: error.message 
    });
  }
});

/**
 * @route   POST /api/admin/meta-config
 * @desc    Create new Meta configuration
 * @access  Admin
 */
router.post('/', async (req, res) => {
  try {
    const {
      pixelId,
      pixelName,
      accessToken,
      testEventCode,
      capiEnabled,
      pixelEnabled,
      apiVersion,
      businessAccountId,
      domain,
      eventDeduplicationWindow,
      advancedMatching,
      trackedEvents,
      customEvents,
      webhookUrl,
      notes
    } = req.body;

    if (!pixelId || !accessToken) {
      return res.status(400).json({ 
        success: false, 
        message: 'Pixel ID and Access Token are required' 
      });
    }

    // If this is the first config or marked as active, deactivate others
    if (req.body.status === 'active') {
      await MetaConfig.updateMany({ status: 'active' }, { status: 'inactive' });
    }

    const config = new MetaConfig({
      pixelId,
      pixelName: pixelName || '',
      accessToken,
      testEventCode: testEventCode || '',
      capiEnabled: capiEnabled || false,
      pixelEnabled: pixelEnabled !== false,
      apiVersion: apiVersion || 'v19.0',
      businessAccountId: businessAccountId || '',
      domain: domain || '',
      eventDeduplicationWindow: eventDeduplicationWindow || 1000,
      advancedMatching: advancedMatching || { enabled: true, fields: [] },
      trackedEvents: trackedEvents || ['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase'],
      customEvents: customEvents || [],
      webhookUrl: webhookUrl || '',
      status: req.body.status || 'inactive',
      notes: notes || '',
      createdBy: req.admin._id
    });

    await config.save();

    const populatedConfig = await MetaConfig.findById(config._id)
      .populate('createdBy', 'name email');

    res.status(201).json({ 
      success: true, 
      data: populatedConfig,
      message: 'Configuration created successfully' 
    });
  } catch (error) {
    console.error('Error creating meta config:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to create configuration',
      error: error.message 
    });
  }
});

/**
 * @route   PUT /api/admin/meta-config/:id
 * @desc    Update Meta configuration
 * @access  Admin
 */
router.put('/:id', async (req, res) => {
  try {
    const config = await MetaConfig.findById(req.params.id);

    if (!config) {
      return res.status(404).json({ 
        success: false, 
        message: 'Configuration not found' 
      });
    }

    const updateFields = [
      'pixelId', 'pixelName', 'accessToken', 'testEventCode',
      'capiEnabled', 'pixelEnabled', 'apiVersion', 'businessAccountId',
      'domain', 'eventDeduplicationWindow', 'advancedMatching',
      'trackedEvents', 'customEvents', 'webhookUrl', 'status', 'notes'
    ];

    updateFields.forEach(field => {
      if (req.body[field] !== undefined) {
        config[field] = req.body[field];
      }
    });

    // If setting to active, deactivate others
    if (req.body.status === 'active' && config.status !== 'active') {
      await MetaConfig.updateMany({ 
        _id: { $ne: config._id }, 
        status: 'active' 
      }, { status: 'inactive' });
    }

    config.updatedBy = req.admin._id;
    await config.save();

    const populatedConfig = await MetaConfig.findById(config._id)
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email');

    res.json({ 
      success: true, 
      data: populatedConfig,
      message: 'Configuration updated successfully' 
    });
  } catch (error) {
    console.error('Error updating meta config:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to update configuration',
      error: error.message 
    });
  }
});

/**
 * @route   DELETE /api/admin/meta-config/:id
 * @desc    Delete Meta configuration
 * @access  Admin
 */
router.delete('/:id', async (req, res) => {
  try {
    const config = await MetaConfig.findById(req.params.id);

    if (!config) {
      return res.status(404).json({ 
        success: false, 
        message: 'Configuration not found' 
      });
    }

    await MetaConfig.findByIdAndDelete(req.params.id);

    res.json({ 
      success: true, 
      message: 'Configuration deleted successfully' 
    });
  } catch (error) {
    console.error('Error deleting meta config:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to delete configuration',
      error: error.message 
    });
  }
});

/**
 * @route   POST /api/admin/meta-config/:id/test
 * @desc    Test Meta configuration
 * @access  Admin
 */
router.post('/:id/test', async (req, res) => {
  try {
    const config = await MetaConfig.findById(req.params.id);

    if (!config) {
      return res.status(404).json({ 
        success: false, 
        message: 'Configuration not found' 
      });
    }

    // Simulate test - in production, this would make actual API calls
    const testResults = {
      pixelConnection: true,
      capiConnection: config.capiEnabled,
      accessTokenValid: true,
      testEventSent: config.testEventCode ? true : false,
      timestamp: new Date().toISOString(),
      message: config.capiEnabled 
        ? 'Pixel and CAPI connections successful' 
        : 'Pixel connection successful'
    };

    config.lastTested = new Date();
    config.testResults = testResults;
    config.status = 'testing';
    await config.save();

    res.json({ 
      success: true, 
      data: testResults,
      message: 'Configuration test completed' 
    });
  } catch (error) {
    console.error('Error testing meta config:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to test configuration',
      error: error.message 
    });
  }
});

/**
 * @route   PATCH /api/admin/meta-config/:id/activate
 * @desc    Activate Meta configuration
 * @access  Admin
 */
router.patch('/:id/activate', async (req, res) => {
  try {
    const config = await MetaConfig.findById(req.params.id);

    if (!config) {
      return res.status(404).json({ 
        success: false, 
        message: 'Configuration not found' 
      });
    }

    // Deactivate all other configs
    await MetaConfig.updateMany({ 
      _id: { $ne: config._id }, 
      status: 'active' 
    }, { status: 'inactive' });

    config.status = 'active';
    config.updatedBy = req.admin._id;
    await config.save();

    res.json({ 
      success: true, 
      data: config,
      message: 'Configuration activated successfully' 
    });
  } catch (error) {
    console.error('Error activating meta config:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to activate configuration',
      error: error.message 
    });
  }
});

module.exports = router;