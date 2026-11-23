/**
 * Central Express error handling.
 *
 * Every failure — thrown ApiError, body-parser rejection, multer limit,
 * Mongoose validation/cast/duplicate, image processing rejection or a genuine
 * crash — is converted here into ONE response shape:
 *
 *   {
 *     success: false,
 *     message: "<same as error.message>",   // kept for backward compatibility
 *     error: {
 *       code: "FILE_TOO_LARGE",             // stable machine-readable code
 *       message: "<safe user-facing text>",
 *       details?: {...},                    // optional, safe extra context
 *       requestId: "<correlation id>"
 *     }
 *   }
 *
 * The legacy top-level `message` is preserved so every existing client
 * (`err.message`, `data?.message`) keeps working unchanged.
 *
 * Nothing internal is ever serialised: unknown errors become a generic 500
 * message, while the real error (stack, driver wording, storage details) is
 * written to the server log only, tagged with the request id.
 */

const { ApiError } = require('../lib/apiError');

// Image pipeline codes (see services/imageProcessor.js) → HTTP semantics.
const IMAGE_CODE_STATUS = {
  UNSUPPORTED_FORMAT: 415,
  FILE_TOO_LARGE: 413,
  IMAGE_TOO_LARGE: 413,
  INVALID_IMAGE: 422,
  EMPTY_FILE: 400,
};

const IMAGE_CODE_MESSAGES = {
  UNSUPPORTED_FORMAT: 'This image format is not supported. Please choose a JPG, PNG, WebP, AVIF, GIF or SVG file.',
  FILE_TOO_LARGE: 'This image is too large. Please choose a smaller file.',
  IMAGE_TOO_LARGE: 'This image is too large to process. Please choose a smaller image.',
  INVALID_IMAGE: 'This image appears damaged or cannot be opened. Please choose another file.',
  EMPTY_FILE: 'No file was received. Please choose a file and try again.',
};

const GENERIC_500 = "We're having trouble processing your request. Please try again shortly.";

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : String(xff || '');
  return (first.split(',')[0] || '').trim() || req.ip || '';
}

/** Strip query strings so signed media URLs never land in logs. */
function safePath(req) {
  return String(req.originalUrl || req.url || '').split('?')[0];
}

function logFailure(req, err, status, code) {
  const meta = {
    requestId: req.id,
    method: req.method,
    path: safePath(req),
    status,
    code,
    ip: clientIp(req),
  };
  if (status >= 500) {
    console.error('[error]', { ...meta, name: err?.name, message: err?.message, stack: err?.stack });
  } else {
    // 4xx are expected outcomes (bad input, expired session); keep them terse.
    console.warn('[error]', { ...meta, name: err?.name, message: err?.message });
  }
}

/** Turn anything thrown anywhere into { status, code, message, details }. */
function normalize(err) {
  // 1. Deliberate, already-safe application errors.
  if (err instanceof ApiError) {
    return {
      status: err.status,
      code: err.code,
      message: err.expose ? err.message : GENERIC_500,
      details: err.expose ? err.details : undefined,
    };
  }

  // 2. Image pipeline (services/imageProcessor.js ImageValidationError).
  if (err && err.name === 'ImageValidationError') {
    const code = String(err.code || 'INVALID_IMAGE');
    const status = IMAGE_CODE_STATUS[code] || 400;
    // The processor's messages are curated and contain no internals; keep the
    // specific wording (it already states limits/sizes) but never the stack.
    const message = String(err.message || '').trim() || IMAGE_CODE_MESSAGES[code] || IMAGE_CODE_MESSAGES.INVALID_IMAGE;
    return { status, code, message };
  }

  // 3. Multer
  if (err && typeof err.code === 'string' && err.code.startsWith('LIMIT_')) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const limitBytes = Number(err.limit) || 0;
      const maxSizeMB = limitBytes > 0 ? Math.round((limitBytes / (1024 * 1024)) * 10) / 10 : undefined;
      return {
        status: 413,
        code: 'FILE_TOO_LARGE',
        message: maxSizeMB
          ? `This file is too large. Maximum allowed size is ${maxSizeMB} MB.`
          : 'This file is too large. Please choose a smaller file.',
        details: maxSizeMB ? { maxSizeMB } : undefined,
      };
    }
    return {
      status: 400,
      code: 'UPLOAD_ERROR',
      message: 'The file could not be accepted. Please choose a different file.',
    };
  }

  // 4. Body parser
  if (err && err.type === 'entity.too.large') {
    return {
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'The request is too large. Please reduce the size and try again.',
    };
  }
  if (err && (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err))) {
    return {
      status: 400,
      code: 'INVALID_JSON',
      message: 'The request could not be read. Please refresh and try again.',
    };
  }
  if (err && err.type === 'encoding.unsupported') {
    return { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'This request format is not supported.' };
  }

  // 5. MongoDB / Mongoose
  if (err && err.code === 11000) {
    return {
      status: 409,
      code: 'DUPLICATE_KEY',
      message: 'A record with these details already exists.',
    };
  }
  if (err && err.name === 'CastError') {
    return {
      status: 400,
      code: 'INVALID_ID',
      message: 'The request contains an invalid identifier.',
    };
  }
  if (err && err.name === 'ValidationError' && err.errors && typeof err.errors === 'object') {
    const details = Object.keys(err.errors).slice(0, 20).map((field) => ({
      field,
      message: 'This value is not valid.',
    }));
    return {
      status: 422,
      code: 'VALIDATION_FAILED',
      message: 'Please check the highlighted fields.',
      details,
    };
  }
  if (err && (err.name === 'MongooseServerSelectionError' || err.name === 'MongoNetworkError')) {
    return {
      status: 503,
      code: 'DATABASE_UNAVAILABLE',
      message: 'The service is temporarily unavailable. Please try again shortly.',
    };
  }

  // 6. Auth (jsonwebtoken)
  if (err && (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError' || err.name === 'NotBeforeError')) {
    return {
      status: 401,
      code: err.name === 'TokenExpiredError' ? 'SESSION_EXPIRED' : 'INVALID_TOKEN',
      message: 'Your session has expired. Please sign in again.',
    };
  }

  // 7. sharp / storage failures are upstream problems, not client mistakes.
  if (err && /sharp|vips/i.test(String(err.name || err.message || ''))) {
    return {
      status: 422,
      code: 'IMAGE_PROCESSING_FAILED',
      message: 'This image could not be processed. Please choose another file.',
    };
  }

  // 8. Anything with an explicit status that we did not model above.
  const status = Number(err?.statusCode || err?.status || 0);
  if (status >= 400 && status < 500) {
    return {
      status,
      code: String(err.code || 'BAD_REQUEST'),
      message: String(err.message || 'The request could not be processed.'),
    };
  }

  // 9. Unknown: never leak the real message.
  return { status: 500, code: 'INTERNAL_ERROR', message: GENERIC_500 };
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const { status, code, message, details } = normalize(err);
  logFailure(req, err, status, code);

  if (res.headersSent) {
    // The response is already streaming; the only safe action is to abort.
    try {
      res.destroy();
    } catch (_e) {
      /* ignore */
    }
    return;
  }

  if (status === 429) {
    const retryAfter = req.rateLimit?.resetTime
      ? Math.max(0, Math.ceil((new Date(req.rateLimit.resetTime).getTime() - Date.now()) / 1000))
      : undefined;
    if (retryAfter !== undefined) res.setHeader('Retry-After', String(retryAfter));
  }

  res.status(status).json({
    success: false,
    message,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
      requestId: req.id || '',
    },
  });
}

/** JSON 404 for unmatched API/media paths (never an HTML error page). */
function notFoundHandler(req, res, next) {
  const path = String(req.path || '');
  const isApiLike = path.startsWith('/api') || path.startsWith('/uploads') || path.startsWith('/feed');
  if (!isApiLike) return next();

  const message = 'The requested resource could not be found.';
  const body = {
    success: false,
    message,
    error: { code: 'NOT_FOUND', message, requestId: req.id || '' },
  };
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.setHeader('Cache-Control', 'no-store');
  }
  return res.status(404).json(body);
}

/** Shared handler for express-rate-limit so 429s use the standard envelope. */
function rateLimitHandler(req, res) {
  const reset = req.rateLimit?.resetTime ? new Date(req.rateLimit.resetTime).getTime() : NaN;
  const retryAfter = Number.isFinite(reset) ? Math.max(0, Math.ceil((reset - Date.now()) / 1000)) : 60;
  res.setHeader('Retry-After', String(retryAfter));

  console.warn('[error]', {
    requestId: req.id,
    method: req.method,
    path: safePath(req),
    status: 429,
    code: 'RATE_LIMITED',
    ip: clientIp(req),
  });

  res.status(429).json({
    success: false,
    message: 'Too many requests. Please wait a moment and try again.',
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests. Please wait a moment and try again.',
      details: { retryAfterSeconds: retryAfter },
      requestId: req.id || '',
    },
  });
}

module.exports = { errorHandler, notFoundHandler, rateLimitHandler, normalize };
