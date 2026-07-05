/**
 * Rate Limiting Middleware
 * Prevents API abuse and DDoS attacks
 * 
 * Usage:
 * const { createRateLimiter, globalRateLimit } = require('./middleware/rateLimiter');
 * app.use(globalRateLimit);
 * app.post('/auth/login', createRateLimiter('login', 5, 15 * 60), handler);
 */

const { Logger } = require('../utils/logger');
const { sendError } = require('../utils/responseHandler');

// Store for tracking request counts
// Format: { key: { count, resetTime } }
const requestLimits = new Map();
let cleanupInterval = null;

/**
 * Global rate limiter - 100 requests per minute per IP
 */
function globalRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const key = `global:${ip}`;
  const now = Date.now();
  const windowSize = 60 * 1000; // 1 minute
  const maxRequests = 100;

  let record = requestLimits.get(key);

  if (!record || now - record.resetTime > windowSize) {
    record = { count: 1, resetTime: now };
    requestLimits.set(key, record);
    next();
  } else if (record.count < maxRequests) {
    record.count++;
    next();
  } else {
    Logger.warn('rateLimit', 'Global rate limit exceeded', {
      ip,
      count: record.count,
      limit: maxRequests,
    });
    sendError(res, 429, 'Too many requests. Please try again later.', 'RATE_LIMIT_EXCEEDED');
  }
}

/**
 * Create endpoint-specific rate limiter
 * @param {string} name - Identifier for this limit (e.g., 'login', 'register')
 * @param {number} maxRequests - Maximum requests allowed
 * @param {number} windowSizeSeconds - Time window in seconds
 * @returns {Function} Middleware function
 */
function createRateLimiter(name, maxRequests, windowSizeSeconds = 1800) {
  const windowSize = windowSizeSeconds * 1000;

  return (req, res, next) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const email = typeof req.body?.email === 'string'
      ? String(req.body.email).toLowerCase().trim()
      : null;
    const userId = typeof req.body?.userId === 'string'
      ? String(req.body.userId).trim()
      : typeof req.params?.userId === 'string'
        ? String(req.params?.userId).trim()
        : null;
    const headerUserId = typeof req.headers?.['x-user-id'] === 'string'
      ? String(req.headers['x-user-id']).trim()
      : null;
    const identity = email || userId || headerUserId || 'anonymous';
    // Use IP + actual identity (email/userId) so shared IPs don't block all users.
    const key = `${name}:${ip}:${identity}`;
    const now = Date.now();

    let record = requestLimits.get(key);

    if (!record || now - record.resetTime > windowSize) {
      // Reset counter
      record = { count: 1, resetTime: now };
      requestLimits.set(key, record);
      next();
    } else if (record.count < maxRequests) {
      record.count++;
      next();
    } else {
      const resetTime = new Date(record.resetTime + windowSize).toISOString();
      Logger.warn('rateLimit', `Rate limit exceeded for ${name}`, {
        ip,
        userId,
        count: record.count,
        limit: maxRequests,
        resetTime,
      });
      sendError(
        res,
        429,
        `Too many ${name} attempts. Reset at ${resetTime}`,
        {
          code: 'RATE_LIMIT_EXCEEDED',
          count: record.count,
          limit: maxRequests,
          resetTime,
        }
      );
    }
  };
}

/**
 * Clean up expired rate limit records periodically
 * Call this once on server startup
 */
function startCleanupInterval() {
  if (cleanupInterval) return cleanupInterval;

  cleanupInterval = setInterval(() => {
    const now = Date.now();
    const maxAge = 2 * 60 * 60 * 1000; // 2 hours

    for (const [key, record] of requestLimits.entries()) {
      if (now - record.resetTime > maxAge) {
        requestLimits.delete(key);
      }
    }

    const size = requestLimits.size;
    Logger.debug('rateLimit', `Cleaned up expired records. Current size: ${size}`);
  }, 15 * 60 * 1000); // Run every 15 minutes

  return cleanupInterval;
}

function stopCleanupInterval() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

module.exports = {
  globalRateLimit,
  createRateLimiter,
  startCleanupInterval,
  stopCleanupInterval,
  // Admin: get/reset functions removed — not referenced in codebase
};
