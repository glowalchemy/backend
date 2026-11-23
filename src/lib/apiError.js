/**
 * ApiError — the single error type routes/services should throw.
 *
 * Everything a client is allowed to see lives in `message` (safe, user-facing,
 * no internals). Everything else (`code`, `details`, `cause`) exists for stable
 * machine handling and for server-side diagnostics.
 *
 * `expose: false` marks an unexpected internal failure: the handler replaces
 * its message with a generic one so stack traces, Mongo wording, file paths or
 * B2 errors can never reach a customer.
 */

class ApiError extends Error {
  constructor({
    status = 500,
    code = 'INTERNAL_ERROR',
    message = 'Something went wrong. Please try again.',
    details = undefined,
    expose = status < 500,
    cause = undefined,
  } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.statusCode = status;
    this.code = code;
    this.details = details;
    this.expose = expose;
    if (cause) this.cause = cause;
  }
}

// --- Convenience constructors for the cases the app actually produces --------

const badRequest = (message = 'The request could not be processed.', details, code = 'BAD_REQUEST') =>
  new ApiError({ status: 400, code, message, details });

const unauthorized = (message = 'Please sign in to continue.', code = 'AUTH_REQUIRED') =>
  new ApiError({ status: 401, code, message });

const forbidden = (message = "You don't have permission to perform this action.", code = 'FORBIDDEN') =>
  new ApiError({ status: 403, code, message });

const notFound = (message = 'The requested item could not be found.', code = 'NOT_FOUND') =>
  new ApiError({ status: 404, code, message });

const conflict = (message = 'This action conflicts with the current state. Please refresh and try again.', code = 'CONFLICT', details) =>
  new ApiError({ status: 409, code, message, details });

const validationFailed = (message = 'Please check the highlighted fields.', details) =>
  new ApiError({ status: 422, code: 'VALIDATION_FAILED', message, details });

const rateLimited = (message = 'Too many requests. Please wait a moment and try again.') =>
  new ApiError({ status: 429, code: 'RATE_LIMITED', message });

const serviceUnavailable = (message = 'The service is temporarily unavailable. Please try again shortly.') =>
  new ApiError({ status: 503, code: 'SERVICE_UNAVAILABLE', message });

const internal = (message = "We're having trouble processing your request. Please try again shortly.", cause) =>
  new ApiError({ status: 500, code: 'INTERNAL_ERROR', message, expose: false, cause });

/** Wrap a rejected promise so async route failures reach the error middleware. */
const asyncRoute = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = {
  ApiError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  validationFailed,
  rateLimited,
  serviceUnavailable,
  internal,
  asyncRoute,
};
