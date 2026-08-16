const mongoose = require('mongoose');

const eventLogSchema = new mongoose.Schema({
  eventId: {
    type: String,
    required: true,
    unique: true
  },
  eventName: {
    type: String,
    required: true,
    enum: ['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase', 'Lead', 'CustomEvent', 'Search', 'Contact']
  },
  eventTime: {
    type: Date,
    required: true
  },
  eventSource: {
    type: String,
    enum: ['pixel', 'capi', 'both'],
    default: 'pixel'
  },
  pixelId: {
    type: String,
    default: ''
  },
  campaignId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Campaign',
    default: null
  },
  userId: {
    type: String,
    default: ''
  },
  externalId: {
    type: String,
    default: ''
  },
  fbp: {
    type: String,
    default: ''
  },
  fbc: {
    type: String,
    default: ''
  },
  userData: {
    email: String,
    phone: String,
    firstName: String,
    lastName: String,
    city: String,
    state: String,
    country: String,
    postalCode: String,
    externalId: String
  },
  customData: {
    value: Number,
    currency: String,
    contentIds: [String],
    contentType: String,
    contentName: String,
    contents: [{
      id: String,
      quantity: Number,
      item_price: Number
    }],
    numItems: Number,
    orderId: String,
    predictedLtv: Number
  },
  url: {
    type: String,
    default: ''
  },
  userAgent: {
    type: String,
    default: ''
  },
  ipAddress: {
    type: String,
    default: ''
  },
  processingStatus: {
    type: String,
    enum: ['pending', 'processed', 'failed'],
    default: 'processed'
  },
  errorMessage: {
    type: String,
    default: ''
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// Indexes for faster queries
eventLogSchema.index({ eventId: 1 }, { unique: true });
eventLogSchema.index({ eventName: 1, eventTime: -1 });
eventLogSchema.index({ eventTime: -1 });
eventLogSchema.index({ campaignId: 1 });
eventLogSchema.index({ pixelId: 1 });
eventLogSchema.index({ processingStatus: 1 });

const EventLog = mongoose.model('EventLog', eventLogSchema);

module.exports = { EventLog };