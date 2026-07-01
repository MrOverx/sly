/**
 * Centralized Logger Utility
 * Replaces mixed console.log / console.error / Logger calls
 * Provides consistent timestamp, context, and formatting across backend
 */

const fs = require('fs');
const path = require('path');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

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
  static _persistenceEnabled = process.env.NODE_ENV !== 'test';
  static _dynamoTableName = process.env.LOGGER_DYNAMODB_TABLE || process.env.DYNAMODB_TABLE || 'oververseDB';
  static _logFilePath = process.env.LOGGER_FILE_PATH
    ? path.resolve(process.env.LOGGER_FILE_PATH)
    : path.resolve(__dirname, '..', 'logs', 'app-logs.jsonl');
  static _docClient = null;

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

  static setLevel(level) {
    this._currentLevel = level;
  }

  static setPersistenceEnabled(enabled) {
    this._persistenceEnabled = enabled;
  }

  static _getDocClient() {
    if (this._docClient) {
      return this._docClient;
    }

    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';
    const endpoint = process.env.DYNAMODB_ENDPOINT || process.env.AWS_ENDPOINT || null;
    const clientOptions = { region };
    if (endpoint) {
      clientOptions.endpoint = endpoint;
    }

    const dynamoClient = new DynamoDBClient(clientOptions);
    this._docClient = DynamoDBDocumentClient.from(dynamoClient, {
      marshallOptions: { removeUndefinedValues: true },
      unmarshallOptions: { convertEmptyValues: false },
    });
    return this._docClient;
  }

  static _hasAwsCredentials() {
    return Boolean(
      process.env.AWS_ACCESS_KEY_ID ||
      process.env.AWS_SECRET_ACCESS_KEY ||
      process.env.AWS_SESSION_TOKEN ||
      process.env.AWS_PROFILE ||
      process.env.AWS_DEFAULT_PROFILE ||
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
      process.env.AWS_ROLE_ARN
    );
  }

  static _buildPersistPayload(level, context, message, data) {
    const timestamp = new Date().toISOString();
    const levelName = Object.keys(this.LOG_LEVELS).find(k => this.LOG_LEVELS[k] === level) || 'INFO';
    return {
      PK: `LOG#${timestamp}`,
      SK: `${String(context || 'system').toUpperCase()}#${Date.now()}#${Math.random().toString(36).slice(2, 8)}`,
      itemType: 'LOG',
      timestamp,
      level: levelName,
      context: String(context || 'system'),
      message: String(message || ''),
      data: this.sanitizeData(data),
    };
  }

  static _appendToFile(payload) {
    try {
      const dir = path.dirname(this._logFilePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this._logFilePath, `${JSON.stringify(payload)}\n`, 'utf8');
      return true;
    } catch (error) {
      console.warn('Logger file persistence failed', error && error.message);
      return false;
    }
  }

  static async _persistToDynamo(payload) {
    try {
      const client = this._getDocClient();
      await client.send(new PutCommand({
        TableName: this._dynamoTableName,
        Item: payload,
      }));
      return true;
    } catch (error) {
      console.warn('Logger DynamoDB persistence failed', error && error.message);
      this._appendToFile({ ...payload, persistenceError: error && error.message });
      return false;
    }
  }

  static _persistLogEntry(level, context, message, data) {
    if (!this._persistenceEnabled) {
      return;
    }

    const payload = this._buildPersistPayload(level, context, message, data);
    const shouldPersistToDynamo = process.env.LOGGER_PERSIST_TO_DYNAMODB === 'true' ||
      process.env.LOGGER_PERSIST_TO_DYNAMODB === '1' ||
      process.env.LOGGER_PERSIST_TO_DYNAMODB === 'yes';

    if (shouldPersistToDynamo && this._hasAwsCredentials()) {
      void this._persistToDynamo(payload);
      return;
    }

    this._appendToFile(payload);
  }

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

    this._persistLogEntry(level, context, message, data);
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
