const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: ['active', 'paused', 'completed', 'draft'],
    default: 'draft'
  },
  platform: {
    type: String,
    enum: ['facebook', 'instagram', 'google', 'tiktok', 'other'],
    default: 'facebook'
  },
  campaignType: {
    type: String,
    enum: ['awareness', 'traffic', 'engagement', 'leads', 'sales'],
    default: 'sales'
  },
  budget: {
    type: Number,
    default: 0
  },
  spent: {
    type: Number,
    default: 0
  },
  startDate: {
    type: Date,
    default: null
  },
  endDate: {
    type: Date,
    default: null
  },
  pixelId: {
    type: String,
    default: ''
  },
  capiEnabled: {
    type: Boolean,
    default: false
  },
  capiAccessToken: {
    type: String,
    default: ''
  },
  trackingEvents: [{
    type: String,
    enum: ['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase', 'Lead', 'CustomEvent']
  }],
  targetAudience: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  objectives: {
    type: String,
    default: ''
  },
  notes: {
    type: String,
    default: ''
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    required: true
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    default: null
  },
  performance: {
    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    conversions: { type: Number, default: 0 },
    ctr: { type: Number, default: 0 }, // Click-through rate
    cpc: { type: Number, default: 0 }, // Cost per click
    cpa: { type: Number, default: 0 }, // Cost per acquisition
    roas: { type: Number, default: 0 } // Return on ad spend
  }
}, {
  timestamps: true
});

// Index for faster queries
campaignSchema.index({ status: 1, platform: 1 });
campaignSchema.index({ createdBy: 1 });
campaignSchema.index({ startDate: 1, endDate: 1 });

const Campaign = mongoose.model('Campaign', campaignSchema);

module.exports = { Campaign };