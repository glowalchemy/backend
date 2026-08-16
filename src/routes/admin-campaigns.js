const express = require('express');
const router = express.Router();
const { Campaign } = require('../models/campaign');
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
 * @route   GET /api/admin/campaigns
 * @desc    Get all campaigns with filtering and pagination
 * @access  Admin
 */
router.get('/', async (req, res) => {
  try {
    const { 
      status, 
      platform, 
      page = 1, 
      limit = 10, 
      search 
    } = req.query;

    const query = {};
    
    if (status) query.status = status;
    if (platform) query.platform = platform;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [campaigns, total] = await Promise.all([
      Campaign.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate('createdBy', 'name email')
        .populate('updatedBy', 'name email'),
      Campaign.countDocuments(query)
    ]);

    res.json({
      success: true,
      data: campaigns,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching campaigns:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch campaigns',
      error: error.message 
    });
  }
});

/**
 * @route   GET /api/admin/campaigns/:id
 * @desc    Get single campaign by ID
 * @access  Admin
 */
router.get('/:id', async (req, res) => {
  try {
    const campaign = await Campaign.findById(req.params.id)
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email');

    if (!campaign) {
      return res.status(404).json({ 
        success: false, 
        message: 'Campaign not found' 
      });
    }

    res.json({ success: true, data: campaign });
  } catch (error) {
    console.error('Error fetching campaign:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch campaign',
      error: error.message 
    });
  }
});

/**
 * @route   POST /api/admin/campaigns
 * @desc    Create new campaign
 * @access  Admin
 */
router.post('/', async (req, res) => {
  try {
    const {
      name,
      description,
      status,
      platform,
      campaignType,
      budget,
      startDate,
      endDate,
      pixelId,
      capiEnabled,
      capiAccessToken,
      trackingEvents,
      targetAudience,
      objectives,
      notes
    } = req.body;

    if (!name) {
      return res.status(400).json({ 
        success: false, 
        message: 'Campaign name is required' 
      });
    }

    const campaign = new Campaign({
      name,
      description,
      status: status || 'draft',
      platform: platform || 'facebook',
      campaignType: campaignType || 'sales',
      budget: budget || 0,
      startDate: startDate || null,
      endDate: endDate || null,
      pixelId: pixelId || '',
      capiEnabled: capiEnabled || false,
      capiAccessToken: capiAccessToken || '',
      trackingEvents: trackingEvents || [],
      targetAudience: targetAudience || {},
      objectives: objectives || '',
      notes: notes || '',
      createdBy: req.admin._id
    });

    await campaign.save();

    const populatedCampaign = await Campaign.findById(campaign._id)
      .populate('createdBy', 'name email');

    res.status(201).json({ 
      success: true, 
      data: populatedCampaign,
      message: 'Campaign created successfully' 
    });
  } catch (error) {
    console.error('Error creating campaign:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to create campaign',
      error: error.message 
    });
  }
});

/**
 * @route   PUT /api/admin/campaigns/:id
 * @desc    Update campaign
 * @access  Admin
 */
router.put('/:id', async (req, res) => {
  try {
    const campaign = await Campaign.findById(req.params.id);

    if (!campaign) {
      return res.status(404).json({ 
        success: false, 
        message: 'Campaign not found' 
      });
    }

    const updateFields = [
      'name', 'description', 'status', 'platform', 'campaignType',
      'budget', 'spent', 'startDate', 'endDate', 'pixelId',
      'capiEnabled', 'capiAccessToken', 'trackingEvents',
      'targetAudience', 'objectives', 'notes'
    ];

    updateFields.forEach(field => {
      if (req.body[field] !== undefined) {
        campaign[field] = req.body[field];
      }
    });

    campaign.updatedBy = req.admin._id;
    await campaign.save();

    const populatedCampaign = await Campaign.findById(campaign._id)
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email');

    res.json({ 
      success: true, 
      data: populatedCampaign,
      message: 'Campaign updated successfully' 
    });
  } catch (error) {
    console.error('Error updating campaign:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to update campaign',
      error: error.message 
    });
  }
});

/**
 * @route   DELETE /api/admin/campaigns/:id
 * @desc    Delete campaign
 * @access  Admin
 */
router.delete('/:id', async (req, res) => {
  try {
    const campaign = await Campaign.findById(req.params.id);

    if (!campaign) {
      return res.status(404).json({ 
        success: false, 
        message: 'Campaign not found' 
      });
    }

    await Campaign.findByIdAndDelete(req.params.id);

    res.json({ 
      success: true, 
      message: 'Campaign deleted successfully' 
    });
  } catch (error) {
    console.error('Error deleting campaign:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to delete campaign',
      error: error.message 
    });
  }
});

/**
 * @route   PATCH /api/admin/campaigns/:id/status
 * @desc    Update campaign status
 * @access  Admin
 */
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;

    if (!['active', 'paused', 'completed', 'draft'].includes(status)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid status' 
      });
    }

    const campaign = await Campaign.findById(req.params.id);

    if (!campaign) {
      return res.status(404).json({ 
        success: false, 
        message: 'Campaign not found' 
      });
    }

    campaign.status = status;
    campaign.updatedBy = req.admin._id;
    await campaign.save();

    res.json({ 
      success: true, 
      data: campaign,
      message: 'Campaign status updated successfully' 
    });
  } catch (error) {
    console.error('Error updating campaign status:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to update campaign status',
      error: error.message 
    });
  }
});

/**
 * @route   GET /api/admin/campaigns/stats/overview
 * @desc    Get campaign statistics overview
 * @access  Admin
 */
router.get('/stats/overview', async (req, res) => {
  try {
    const stats = await Campaign.aggregate([
      {
        $group: {
          _id: null,
          totalCampaigns: { $sum: 1 },
          activeCampaigns: {
            $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] }
          },
          pausedCampaigns: {
            $sum: { $cond: [{ $eq: ['$status', 'paused'] }, 1, 0] }
          },
          completedCampaigns: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
          },
          totalBudget: { $sum: '$budget' },
          totalSpent: { $sum: '$spent' },
          totalImpressions: { $sum: '$performance.impressions' },
          totalClicks: { $sum: '$performance.clicks' },
          totalConversions: { $sum: '$performance.conversions' }
        }
      }
    ]);

    const platformStats = await Campaign.aggregate([
      {
        $group: {
          _id: '$platform',
          count: { $sum: 1 },
          totalBudget: { $sum: '$budget' },
          totalSpent: { $sum: '$spent' }
        }
      }
    ]);

    res.json({
      success: true,
      data: {
        overview: stats[0] || {
          totalCampaigns: 0,
          activeCampaigns: 0,
          pausedCampaigns: 0,
          completedCampaigns: 0,
          totalBudget: 0,
          totalSpent: 0,
          totalImpressions: 0,
          totalClicks: 0,
          totalConversions: 0
        },
        byPlatform: platformStats
      }
    });
  } catch (error) {
    console.error('Error fetching campaign stats:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch campaign statistics',
      error: error.message 
    });
  }
});

module.exports = router;