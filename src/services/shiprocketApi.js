/**
 * shiprocketApi.js — Thin facade over shiprocket.service.js
 *
 * This file exists for backward compatibility with routes that import from it
 * (shiprocketSync.js, shiprocketData.js). All token management, retry logic,
 * and Shiprocket API calls are handled by shiprocket.service.js to avoid
 * duplicate token caching and inconsistent behavior.
 */

const {
  getShiprocketToken: _getToken,
  shiprocketRequest,
  getShiprocketOrderDetails,
  invalidateToken,
} = require('./shiprocket.service');

const SHIPROCKET_BASE_URL = 'https://apiv2.shiprocket.in/v1/external';

// Re-export getShiprocketToken as getValidShiprocketToken for backward compat
async function getValidShiprocketToken() {
  return _getToken();
}

// Re-export the same as getShiprocketToken (alias)
async function getShiprocketToken() {
  return _getToken();
}

// Get order status from Shiprocket API using shipment ID
async function getShiprocketOrderStatus(shipmentId) {
  const url = `${SHIPROCKET_BASE_URL}/courier/track/shipment/${shipmentId}`;
  const res = await shiprocketRequest({ method: 'GET', url });
  return res.data;
}

// Get all orders from Shiprocket
async function getShiprocketOrders(page = 0, limit = 100) {
  const url = `${SHIPROCKET_BASE_URL}/orders?page=${page}&limit=${limit}`;
  const res = await shiprocketRequest({ method: 'GET', url });
  return res.data;
}

// Sync order status from Shiprocket API using AWB with retry mechanism
async function syncOrderFromShiprocket(awbNumber, retryCount = 0) {
  const maxRetries = 3;
  const baseDelay = 1000;

  try {
    const url = `${SHIPROCKET_BASE_URL}/courier/track/awb/${awbNumber}`;
    const response = await shiprocketRequest({
      method: 'GET',
      url,
      timeout: 10000,
    });

    const data = response.data;
    console.log(`[Shiprocket API] Raw response for AWB ${awbNumber}:`, JSON.stringify(data, null, 2));

    // Get status from correct field - shipment_track[0].current_status
    let originalStatus = '';
    try {
      const trackData = data.tracking_data?.shipment_track?.[0];
      if (trackData?.current_status) {
        originalStatus = String(trackData.current_status).trim();
        console.log(`[Shiprocket API] Using correct field - current_status: "${originalStatus}"`);
      } else {
        originalStatus = String(data.status || '').trim();
        console.log(`[Shiprocket API] Using fallback field - status: "${originalStatus}"`);
      }
    } catch (_e) {
      originalStatus = String(data.status || '').trim();
      console.log(`[Shiprocket API] Error accessing tracking_data, using fallback status`);
    }

    // Get sr-status-label from latest activity for admin display
    let adminStatus = '';
    try {
      const activities = data.tracking_data?.shipment_track_activities;
      if (activities && activities.length > 0) {
        const latestActivity = activities[0];
        adminStatus = latestActivity['sr-status-label'] || originalStatus;
        console.log(`[Shiprocket API] Using sr-status-label for admin: "${adminStatus}"`);
      }
    } catch (_e) {
      adminStatus = originalStatus;
      console.log(`[Shiprocket API] Error accessing activities, using current_status`);
    }

    // Normalize status — comprehensive mapping
    const statusMap = {
      'NEW': 'new',
      'PICKED_UP': 'processing',
      'IN_TRANSIT': 'shipped',
      'OUT_FOR_DELIVERY': 'shipped',
      'DELIVERED': 'delivered',
      'CANCELLED': 'cancelled',
      'RETURNED': 'returned',
      'RTO': 'cancelled',
      'DEL': 'delivered',
      'DELIVERED': 'delivered',
      'DLV': 'delivered',
      'D': 'delivered',
      'DISPATCHED': 'shipped',
      'SHIPPED': 'shipped',
      'ON_THE_WAY': 'shipped',
      'OUT_FOR_DEL': 'shipped',
      'OFD': 'shipped',
      'PROCESSING': 'processing',
      'PACKED': 'processing',
      'READY_TO_SHIP': 'processing',
      'ORDER_PLACED': 'new',
      'ORDER_CONFIRMED': 'processing',
      'CANCEL': 'cancelled',
      'CANCELED': 'cancelled',
      'REJECTED': 'cancelled',
      'RETURN': 'returned',
      'RETURN_REQUESTED': 'returned',
      'RETURN_INITIATED': 'returned',
    };

    const normalizedStatus = originalStatus.toUpperCase().trim();
    const currentStatus = statusMap[normalizedStatus] || 'processing';

    console.log(`[Shiprocket API] Status mapping for AWB ${awbNumber}:`);
    console.log(`  - Original: "${originalStatus}"`);
    console.log(`  - Normalized: "${normalizedStatus}"`);
    console.log(`  - Mapped to: "${currentStatus}"`);

    if (originalStatus.toLowerCase().includes('deliver') ||
        normalizedStatus.includes('DELIVER') ||
        normalizedStatus.includes('DLV')) {
      console.log(`[Shiprocket API] Detected delivered status - forcing to 'delivered'`);
      return {
        status: 'delivered',
        adminStatus: adminStatus || 'DELIVERED',
        trackingData: data,
        lastUpdated: new Date(),
      };
    }

    return {
      status: currentStatus,
      adminStatus,
      trackingData: data,
      lastUpdated: new Date(),
    };
  } catch (error) {
    console.error(`[Shiprocket] Sync failed for AWB ${awbNumber}:`, error.response?.data || error.message);

    // Retry logic with exponential backoff
    if (retryCount < maxRetries) {
      const delay = baseDelay * Math.pow(2, retryCount);
      console.log(`[Shiprocket] Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return syncOrderFromShiprocket(awbNumber, retryCount + 1);
    }

    console.error(`[Shiprocket] Max retries reached for AWB ${awbNumber}`);
    return null;
  }
}

module.exports = {
  getShiprocketToken,
  getValidShiprocketToken,
  getShiprocketOrderStatus,
  getShiprocketOrders,
  syncOrderFromShiprocket,
};
