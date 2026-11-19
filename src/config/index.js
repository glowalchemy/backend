// Centralized, validated environment configuration for the backend.
//
// Every environment-dependent value used by the backend should be read from
// this module instead of scattering `process.env.X` (and hardcoded fallbacks)
// throughout route/model/service files.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const env = process.env;

const nodeEnv = String(env.NODE_ENV || 'development').toLowerCase();
const isProduction = nodeEnv === 'production';

// Known placeholder/weak JWT secrets that must never be used in any environment.
const WEAK_JWT_SECRETS = new Set([
  'your-secret-key',
  'your-super-secret-jwt-key-change-this-in-production',
  'secret',
  'changeme',
  'change-this-in-production',
  'jwt_secret',
]);

const jwtSecret = String(env.JWT_SECRET || '').trim();

const isJwtSecretSecure =
  jwtSecret.length >= 16 && !WEAK_JWT_SECRETS.has(jwtSecret.toLowerCase());

const port = (() => {
  const n = Number(env.PORT);
  return Number.isInteger(n) && n > 0 ? n : 5000;
})();

// Canonical brand name — single source of truth is the BRAND_NAME env value.
const brandName = String(env.BRAND_NAME || 'GlowAlchemy').trim();

// CORS allowlist. Provide a comma-separated list via CORS_ORIGINS for
// staging/production (e.g. https://glowalchemy.in,https://admin.glowalchemy.in).
// In production, requests from any origin other than the allowlist are rejected.
const corsOrigins = (() => {
  const raw = String(env.CORS_ORIGINS || '').trim();
  if (raw) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (isProduction) {
    return [];
  }
  // In development, allow localhost, 127.0.0.1, and common network IP ranges
  return [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:8080',
    'http://localhost:8081',
    'http://localhost:5000',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:8080',
    'http://127.0.0.1:8081',
    'http://127.0.0.1:5000',
    // Allow devtunnels URLs for development
    'https://56n4nblq-8080.inc1.devtunnels.ms',
    'https://56n4nblq-3000.inc1.devtunnels.ms',
    // Allow common network IP ranges for development
    /^http:\/\/192\.168\.\d+\.\d+:\d+$/,
    /^http:\/\/10\.\d+\.\d+\.\d+:\d+$/,
    /^http:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+:\d+$/,
  ];
})();

// CORS origin callback used by the `cors` package.
// Same-origin requests (origin undefined) and allowlisted origins pass.
function corsOriginCallback(origin, callback) {
  if (!origin) return callback(null, true);
  
  // In development, allow all origins for mobile/tunnel access
  if (!isProduction) {
    return callback(null, true);
  }
  
  // Check for exact match in production
  if (corsOrigins.includes(origin)) return callback(null, true);
  
  // Check for regex patterns (for network IP ranges)
  for (const allowed of corsOrigins) {
    if (allowed instanceof RegExp && allowed.test(origin)) {
      return callback(null, true);
    }
  }
  
  return callback(new Error(`Origin ${origin} not allowed by CORS`));
}

module.exports = {
  nodeEnv,
  isProduction,
  port,
  brandName,
  jwtSecret,
  isJwtSecretSecure,
  corsOrigins,
  corsOriginCallback,
  mongoUri: env.MONGODB_URI || '',
  mongoUriStandard: env.MONGODB_URI_STANDARD || '',
  shiprocketWebhookPath: String(env.SHIPROCKET_WEBHOOK_PATH || '/api/webhooks/shipping'),
  smtpHost: String(env.SMTP_HOST || 'localhost'),
  mailUser: String(env.MAIL_USER || ''),
  mailPass: String(env.MAIL_PASS || ''),
  metaPixelId: String(env.META_PIXEL_ID || ''),
  openaiApiKey: String(env.OPENAI_API_KEY || ''),
  // Additional validation for critical services
  userFrontendUrl: String(env.USER_FRONTEND_URL || 'http://localhost:3000'),
  adminFrontendUrl: String(env.ADMIN_FRONTEND_URL || 'http://localhost:8080'),
  // Catalog/search tuning (all optional; safe defaults below)
  catalogCacheTtlSeconds: Number(env.CATALOG_CACHE_TTL_SECONDS || 15),
  searchAutocompleteMinChars: Number(env.SEARCH_AUTOCOMPLETE_MIN_CHARS || 3),
  searchCandidateCap: Number(env.SEARCH_CANDIDATE_CAP || 150),
  catalogPageSizeMax: Number(env.CATALOG_PAGE_SIZE_MAX || 100),
};
