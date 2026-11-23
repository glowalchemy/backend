const crypto = require('crypto');

/**
 * Request context: a safe correlation id for every request.
 *
 * - Reuses an inbound `X-Request-Id` only when it looks safe (short, printable),
 *   so logs can be correlated across Nginx/app tiers.
 * - Echoes it back as `X-Request-Id` so a customer screenshot or support ticket
 *   can be tied to exactly one server log line.
 * - Logs one concise line per request (method, path, status, duration, id) and
 *   never logs bodies, headers, tokens or cookies.
 */

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

function requestContext(req, res, next) {
  const inbound = String(req.headers['x-request-id'] || '').trim();
  req.id = REQUEST_ID_RE.test(inbound) ? inbound : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);

  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    // Health checks are high-frequency noise; log them only when they fail.
    const isHealth = req.path === '/api/health';
    if (isHealth && res.statusCode < 400) return;

    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const line = `[req ${req.id}] ${req.method} ${req.originalUrl?.split('?')[0] || req.path} ${res.statusCode} ${ms.toFixed(1)}ms`;
    if (res.statusCode >= 500) console.error(line);
    else if (res.statusCode >= 400) console.warn(line);
    else console.log(line);
  });

  next();
}

module.exports = requestContext;
module.exports.REQUEST_ID_RE = REQUEST_ID_RE;
