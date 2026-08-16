const mongoose = require('mongoose');

const metaConfigSchema = new mongoose.Schema({
  pixelId: {
    type: String,
    required: true,
    trim: true
  },
  pixelName: {
    type: String,
    default: ''
  },
  accessToken: {
    type: String,
    required: true,
    trim: true
  },
  testEventCode: {
    type: String,
    default: ''
  },
  capiEnabled: {
    type: Boolean,
    default: false
  },
  pixelEnabled: {
    type: Boolean,
    default: true
  },
  apiVersion: {
    type: String,
    default: 'v19.0'
  },
  businessAccountId: {
    type: String,
    default: ''
  },
  domain: {
    type: String,
    default: ''
  },
  eventDeduplicationWindow: {
    type: Number,
    default: 1000 // 1 second in milliseconds
  },
  advancedMatching: {
    enabled: {
      type: Boolean,
      default: true
    },
    fields: [{
      type: String,
      enum: ['email', 'phone', 'firstName', 'lastName', 'city', 'state', 'country', 'postalCode', 'externalId']
    }]
  },
  trackedEvents: [{
    type: String,
    enum: ['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase', 'Lead', 'CustomEvent', 'Search', 'Contact']
  }],
  customEvents: [{
    name: String,
    description: String
  }],
  webhookUrl: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'testing'],
    default: 'inactive'
  },
  lastTested: {
    type: Date,
    default: null
  },
  testResults: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
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
  }
}, {
  timestamps: true
});

// Index for faster queries
metaConfigSchema.index({ status: 1 });
metaConfigSchema.index({ createdBy: 1 });

const MetaConfig = mongoose.model('MetaConfig', metaConfigSchema);

module.exports = { MetaConfig };