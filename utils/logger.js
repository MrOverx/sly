/**
 * Centralized Logger Utility
 * Replaces mixed console.log / console.error / Logger calls
 * Provides consistent timestamp, context, and formatting across backend
 */

class Logger {
  static LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  };

  static _currentLevel = Logger.LOG_LEVELS.INFO;
  static _rateLimitBuckets = new Map();
  static _rateLimitWindowMs = 5000;
  static _rateLimitMaxEntries = 1;

  static sensitiveKeys = ['password', 'token', 'secret', 'authorization', 'cookie', 'apikey', 'session', 'email'];

  static sanitizeData(data, depth = 0) {
    if (depth > 3 || data === null || data === undefined) {
      return data;
    }

    if (typeof data === 'string') {
      return data.length > 1200 ? `${data.slice(0, 1200)}… [truncated ${data.length - 1200} chars]` : data;
    }

    if (data instanceof Error) {
      return { name: data.name, message: data.message };
    }

    if (Array.isArray(data)) {
      return data.slice(0, 10).map(item => this.sanitizeData(item, depth + 1));
    }

    if (typeof data === 'object') {
      const sanitized = {};
      for (const [key, value] of Object.entries(data)) {
        const lowerKey = String(key).toLowerCase();
        sanitized[key] = this.sensitiveKeys.some(fragment => lowerKey.includes(fragment))
          ? '[REDACTED]'
          : this.sanitizeData(value, depth + 1);
      }
      return sanitized;
    }

    return data;
  }

  /**
   * Set minimum log level for filtering output
   * @param {number} level - Log level threshold
   */
  static setLevel(level) {
    this._currentLevel = level;
  }

  /**
   * Core logging method - all others delegate to this
   * @param {number} level - Log level
   * @param {string} context - Context/module name
   * @param {string} message - Log message
   * @param {object} data - Optional data object
   */
  static _log(level, context, message, data = null) {
    if (level < this._currentLevel) return;

    const timestamp = new Date().toISOString();
    const levelName = Object.keys(this.LOG_LEVELS).find(k => this.LOG_LEVELS[k] === level);
    const logEntry = `[${timestamp}] [${levelName}] [${context}] ${message}`;
    const sanitizedData = data === null || data === undefined ? null : this.sanitizeData(data);
    const bucketKey = `${level}:${context}:${message}`;
    const now = Date.now();
    const existingBucket = this._rateLimitBuckets.get(bucketKey);

    if (existingBucket && now - existingBucket.lastSeen < this._rateLimitWindowMs) {
      existingBucket.count += 1;
      existingBucket.lastSeen = now;
      return;
    }

    if (existingBucket && now - existingBucket.lastSeen >= this._rateLimitWindowMs) {
      this._rateLimitBuckets.delete(bucketKey);
    }

    this._rateLimitBuckets.set(bucketKey, { count: 1, lastSeen: now });

    const logFn = level === this.LOG_LEVELS.ERROR ? console.error : console.log;
    if (sanitizedData !== null) {
      logFn(logEntry, sanitizedData);
    } else {
      logFn(logEntry);
    }
  }

  static debug(context, message, data = null) {
    this._log(this.LOG_LEVELS.DEBUG, context, message, data);
  }

  static info(context, message, data = null) {
    this._log(this.LOG_LEVELS.INFO, context, message, data);
  }

  static warn(context, message, data = null) {
    this._log(this.LOG_LEVELS.WARN, context, message, data);
  }

  static error(context, message, data = null) {
    this._log(this.LOG_LEVELS.ERROR, context, message, data);
  }
}

module.exports = { Logger };
