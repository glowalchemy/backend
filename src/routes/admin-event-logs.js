const express = require('express');
const router = express.Router();
const { EventLog } = require('../models/eventLog');
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
 * @route   GET /api/admin/event-logs
 * @desc    Get event logs with filtering and pagination
 * @access  Admin
 */
router.get('/', async (req, res) => {
  try {
    const { 
      eventName, 
      eventSource, 
      startDate, 
      endDate, 
      page = 1, 
      limit = 50,
      campaignId,
      pixelId
    } = req.query;

    const query = {};
    
    if (eventName) query.eventName = eventName;
    if (eventSource) query.eventSource = eventSource;
    if (campaignId) query.campaignId = campaignId;
    if (pixelId) query.pixelId = pixelId;
    
    if (startDate || endDate) {
      query.eventTime = {};
      if (startDate) query.eventTime.$gte = new Date(startDate);
      if (endDate) query.eventTime.$lte = new Date(endDate);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [logs, total] = await Promise.all([
      EventLog.find(query)
        .sort({ eventTime: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      EventLog.countDocuments(query)
    ]);

    res.json({
      success: true,
      data: logs,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching event logs:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch event logs',
      error: error.message 
    });
  }
});

/**
 * @route   GET /api/admin/event-logs/analytics
 * @desc    Get event analytics and statistics
 * @access  Admin
 */
router.get('/analytics', async (req, res) => {
  try {
    const { startDate, endDate, eventName } = req.query;

    const matchQuery = {};
    if (startDate || endDate) {
      matchQuery.eventTime = {};
      if (startDate) matchQuery.eventTime.$gte = new Date(startDate);
      if (endDate) matchQuery.eventTime.$lte = new Date(endDate);
    }
    if (eventName) matchQuery.eventName = eventName;

    const [
      eventCounts,
      sourceDistribution,
      dailyTrends,
      totalValue
    ] = await Promise.all([
      EventLog.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: '$eventName',
            count: { $sum: 1 }
          }
        },
        { $sort: { count: -1 } }
      ]),
      EventLog.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: '$eventSource',
            count: { $sum: 1 }
          }
        }
      ]),
      EventLog.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: {
              year: { $year: '$eventTime' },
              month: { $month: '$eventTime' },
              day: { $dayOfMonth: '$eventTime' }
            },
            count: { $sum: 1 },
            eventName: { $first: '$eventName' }
          }
        },
        { $sort: { '_id.year': -1, '_id.month': -1, '_id.day': -1 } },
        { $limit: 30 }
      ]),
      EventLog.aggregate([
        { $match: { ...matchQuery, eventName: 'Purchase' } },
        {
          $group: {
            _id: null,
            totalValue: { $sum: '$customData.value' },
            totalPurchases: { $sum: 1 }
          }
        }
      ])
    ]);

    res.json({
      success: true,
      data: {
        eventCounts,
        sourceDistribution,
        dailyTrends,
        purchaseSummary: totalValue[0] || { totalValue: 0, totalPurchases: 0 }
      }
    });
  } catch (error) {
    console.error('Error fetching event analytics:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch event analytics',
      error: error.message 
    });
  }
});

/**
 * @route   GET /api/admin/event-logs/:id
 * @desc    Get single event log by ID
 * @access  Admin
 */
router.get('/:id', async (req, res) => {
  try {
    const log = await EventLog.findOne({ eventId: req.params.id });

    if (!log) {
      return res.status(404).json({ 
        success: false, 
        message: 'Event log not found' 
      });
    }

    res.json({ success: true, data: log });
  } catch (error) {
    console.error('Error fetching event log:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch event log',
      error: error.message 
    });
  }
});

/**
 * @route   DELETE /api/admin/event-logs
 * @desc    Delete event logs by date range or criteria
 * @access  Admin
 */
router.delete('/', async (req, res) => {
  try {
    const { startDate, endDate, eventName } = req.query;

    const query = {};
    
    if (startDate || endDate) {
      query.eventTime = {};
      if (startDate) query.eventTime.$gte = new Date(startDate);
      if (endDate) query.eventTime.$lte = new Date(endDate);
    }
    
    if (eventName) query.eventName = eventName;

    const result = await EventLog.deleteMany(query);

    res.json({ 
      success: true, 
      message: `Deleted ${result.deletedCount} event logs`,
      deletedCount: result.deletedCount 
    });
  } catch (error) {
    console.error('Error deleting event logs:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to delete event logs',
      error: error.message 
    });
  }
});

module.exports = router;