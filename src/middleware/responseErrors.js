/**
 * Response standardisation.
 *
 * The codebase has hundreds of `res.status(4xx).json({ success: false, message })`
 * call sites written over years. Rewriting them all would be a huge, risky diff
 * for no user-visible gain, so instead this middleware upgrades every legacy
 * error response in one place:
 *
 *   { success: false, message: "Invalid product ID" }
 *      ->
 *   { success: false,
 *     message: "Invalid product ID",
 *     error: { code: "BAD_REQUEST", message: "Invalid product ID", requestId: "..." } }
 *
 * It is purely additive - `success` and `message` are untouched, so every
 * existing client keeps working - and it never rewrites a response that already
 * carries a structured `error`, nor a successful one.
 *
 * 5xx messages written from an internal exception ("Cast to ObjectId failed...",
 * "connect ECONNREFUSED ...") are replaced with a safe sentence and logged with
 * the request id instead, so implementation details stop reaching users.
 */

const STATUS_CODES = {
  400: 'BAD_REQUEST',
  401: 'AUTH_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  410: 'GONE',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  501: 'NOT_IMPLEMENTED',
  502: 'UPSTREAM_ERROR',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
};

const SAFE_5XX_MESSAGES = {
  500: "We're having trouble processing your request. Please try again shortly.",
  502: 'An upstream service did not respond correctly. Please try again shortly.',
  503: 'The service is temporarily unavailable. Please try again shortly.',
  504: 'The request took too long to complete. Please try again.',
};

// Markers of leaked internals: driver/engine wording, stacks, paths, hosts.
const TECHNICAL_PATTERNS = [
  /\b(Error|Exception|TypeError|ReferenceError|SyntaxError|CastError|ValidationError|MongoServerError|MongooseError|AggregateError)\b/,
  /\bE11000\b/,
  /\bECONNREFUSED\b/,
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /\bENOTFOUND\b/,
  /\bENOENT\b/,
  /\bEACCES\b/,
  /\bMongo(DB|ose)?\b/,
  /at\s+[\w$.<>]+\s+\(/,
  /\.js:\d+/,
  /node_modules/,
  /\/home\//,
  /\/var\//,
  /[A-Z]:\\/,
  /\bsharp\b/i,
  /\blibvips\b/i,
  /\bS3\b/,
  /\bB2\b/,
  /InvalidObjectId/,
  /undefined is not/,
  /Cannot read propert/,
  /is not a function/,
  /\bstack\b/,
  /Path `[^`]*`/,
  /duplicate key/i,
  /Cast to ObjectId/,
];

function looksTechnical(message) {
  const text = String(message || '').trim();
  if (!text) return true;
  if (text.length > 300) return true;
  return TECHNICAL_PATTERNS.some((re) => re.test(text));
}

function standardizeErrorResponses(req, res, next) {
  const originalJson = res.json.bind(res);

  res.json = (body) => {
    try {
      const status = Number(res.statusCode) || 200;

      if (status < 400 || !body || typeof body !== 'object' || Array.isArray(body) || Buffer.isBuffer(body)) {
        return originalJson(body);
      }

      // Already standardised (central handler, rate limiter, 404 handler).
      const existing = body.error;
      if (existing && typeof existing === 'object' && Object.prototype.hasOwnProperty.call(existing, 'code')) {
        return originalJson(body);
      }

      let message = typeof body.message === 'string' ? body.message : '';
      if (typeof existing === 'string' && !message) message = existing;

      if (status >= 500 && looksTechnical(message)) {
        console.warn('[error] suppressed technical 5xx message', {
          requestId: req.id,
          path: String(req.originalUrl || req.url || '').split('?')[0],
          status,
          message,
        });
        message = SAFE_5XX_MESSAGES[status] || SAFE_5XX_MESSAGES[500];
        body.message = message;
      }

      if (!message) {
        message = SAFE_5XX_MESSAGES[status] || 'The request could not be processed.';
        body.message = message;
      }

      // Keep a string `error` field intact (older clients read it as text) and
      // add the machine-readable envelope beside it.
      body.error = {
        code: STATUS_CODES[status] || (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'),
        message,
        requestId: req.id || '',
      };

      return originalJson(body);
    } catch (_e) {
      // Standardisation must never break a response.
      return originalJson(body);
    }
  };

  next();
}

module.exports = { standardizeErrorResponses, looksTechnical, STATUS_CODES };
