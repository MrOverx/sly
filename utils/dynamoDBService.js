let DynamoDBClient;
let DescribeTableCommand;
if (process.env.TEST_DISABLE_AWS !== 'true') {
  try {
    ({ DynamoDBClient, DescribeTableCommand } = require('@aws-sdk/client-dynamodb'));
  } catch (err) {
    console.warn('[dynamoDBService] AWS SDK for DynamoDB is unavailable:', err && err.message);
    DynamoDBClient = null;
    DescribeTableCommand = null;
  }
} else {
  DynamoDBClient = null;
  DescribeTableCommand = null;
}
const fs = require('fs');
const path = require('path');
let DynamoDBDocumentClient;
let GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, ScanCommand, BatchGetCommand, TransactWriteCommand;
if (process.env.TEST_DISABLE_AWS !== 'true') {
  try {
    ({
      DynamoDBDocumentClient,
      GetCommand,
      PutCommand,
      UpdateCommand,
      DeleteCommand,
      QueryCommand,
      ScanCommand,
      BatchGetCommand,
      TransactWriteCommand,
    } = require('@aws-sdk/lib-dynamodb'));
  } catch (err) {
    console.warn('[dynamoDBService] AWS DynamoDB Document SDK is unavailable:', err && err.message);
    DynamoDBDocumentClient = null;
  }
} else {
  DynamoDBDocumentClient = null;
}
const { Logger } = require('./logger');
const { resolveProfileImageReference, normalizeProfileImageReference } = require('./friendPayloadUtils');
const { normalizeStatusList, pickLatestStatus } = require('./statusNoteUtils');
const crypto = require('crypto');

const TABLE_NAME = process.env.DYNAMODB_TABLE || 'oververseDB';
const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';
const MAX_PROFILE_IMAGE_URL_LENGTH = 20000;
const MAX_INLINE_PROFILE_IMAGE_URL_LENGTH = 120 * 1024; // 120KB limit for persistent inline images

// Allow connecting to a local DynamoDB endpoint (DYNAMODB_ENDPOINT) for development/testing
const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT || process.env.AWS_ENDPOINT || null;
const clientOptions = { region: AWS_REGION };
if (DYNAMODB_ENDPOINT) clientOptions.endpoint = DYNAMODB_ENDPOINT;
const client = DynamoDBClient ? new DynamoDBClient(clientOptions) : null;

function hasAwsCredentials() {
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

function shouldUseDevStoreFallback() {
  const isTestProcess = typeof process.env.JEST_WORKER_ID !== 'undefined' || process.env.NODE_ENV === 'test';
  const explicitTrue = process.env.USE_DEV_STORE === 'true';
  const explicitFalse = process.env.USE_DEV_STORE === 'false';
  const hasCreds = hasAwsCredentials();

  if (process.env.NODE_ENV === 'production' && !isTestProcess) {
    if (explicitTrue) {
      console.error('[dynamoDBService] USE_DEV_STORE=true is not allowed in production. Production must use DynamoDB.');
    }
    return false;
  }

  if (explicitTrue) {
    console.warn('[dynamoDBService] Local dev fallback store enabled explicitly via USE_DEV_STORE=true');
    return true;
  }

  if (explicitFalse) {
    if (!hasCreds && !DYNAMODB_ENDPOINT && !isTestProcess) {
      console.error('[dynamoDBService] USE_DEV_STORE=false and no AWS credentials or DynamoDB endpoint is configured. DynamoDB access will fail unless credentials are provided.');
    } else {
      console.info('[dynamoDBService] Local dev fallback store disabled explicitly via USE_DEV_STORE=false');
    }
    return false;
  }

  if (DYNAMODB_ENDPOINT) {
    console.info('[dynamoDBService] Using local DynamoDB endpoint:', DYNAMODB_ENDPOINT);
    return false;
  }

  if (hasCreds) {
    return false;
  }

  if (isTestProcess) {
    return true;
  }

  console.warn('[dynamoDBService] No AWS credentials detected; falling back to local JSON dev store. Set USE_DEV_STORE=false and provide credentials to use DynamoDB.');
  return true;
}

// Development fallback: simple JSON-backed store used only when explicitly requested,
// when running tests, or when no DynamoDB credentials/endpoint are present and
// USE_DEV_STORE is not explicitly set to false.
const USE_DEV_STORE = shouldUseDevStoreFallback();
const DEV_STORE_PATH = path.resolve(__dirname, '..', 'dev_dynamo_users.json');

function isDevStoreEnabled() {
  return USE_DEV_STORE;
}

function loadDevStore() {
  try {
    if (!fs.existsSync(DEV_STORE_PATH)) {
      fs.writeFileSync(DEV_STORE_PATH, JSON.stringify([]), 'utf8');
    }
    const raw = fs.readFileSync(DEV_STORE_PATH, 'utf8');
    const items = JSON.parse(raw || '[]');
    return Array.isArray(items) ? items : [];
  } catch (err) {
    console.warn('Unable to read dev store:', err && err.message);
    return [];
  }
}

function saveDevStore(items) {
  try {
    fs.writeFileSync(DEV_STORE_PATH, JSON.stringify(items, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.warn('Unable to write dev store:', err && err.message);
    return false;
  }
}

function clearDevStore() {
  try {
    fs.writeFileSync(DEV_STORE_PATH, JSON.stringify([], null, 2), 'utf8');
    return true;
  } catch (err) {
    console.warn('[dynamoDBService] Unable to clear dev store:', err && err.message);
    return false;
  }
}
const ddb = (DynamoDBDocumentClient && client)
  ? DynamoDBDocumentClient.from(client, {
      marshallOptions: {
        removeUndefinedValues: true,
      },
      unmarshallOptions: {
        convertEmptyValues: false,
      },
    })
  : null;

let TABLE_HASH_KEY = 'PK';
let TABLE_RANGE_KEY = 'SK';
let TABLE_HAS_SORT_KEY = true;
let EMAIL_INDEX_AVAILABLE = null;
let TABLE_SCHEMA_LOADED = false;
let TABLE_SCHEMA_PROMISE = null;

async function loadTableSchema() {
  if (USE_DEV_STORE) {
    TABLE_SCHEMA_LOADED = true;
    return;
  }

  if (TABLE_SCHEMA_LOADED) return;
  if (TABLE_SCHEMA_PROMISE) return TABLE_SCHEMA_PROMISE;

  TABLE_SCHEMA_PROMISE = (async () => {
    try {
      const description = await describeTable();
      const schema = description.Table.KeySchema || [];
      const hashKey = schema.find(key => key.KeyType === 'HASH');
      const rangeKey = schema.find(key => key.KeyType === 'RANGE');

      if (hashKey) {
        TABLE_HASH_KEY = hashKey.AttributeName;
      }

      if (!rangeKey) {
        TABLE_HAS_SORT_KEY = false;
        TABLE_RANGE_KEY = null;
        console.info(`DynamoDB table ${TABLE_NAME} detected as HASH-only using key ${TABLE_HASH_KEY}`);
      } else {
        TABLE_RANGE_KEY = rangeKey.AttributeName;
        TABLE_HAS_SORT_KEY = true;
        console.info(`DynamoDB table ${TABLE_NAME} detected with HASH=${TABLE_HASH_KEY}, RANGE=${TABLE_RANGE_KEY}`);
      }
    } catch (error) {
      console.warn(`Unable to infer DynamoDB key schema for ${TABLE_NAME}. Using PK/SK fallback.`, error?.message || error);
    } finally {
      TABLE_SCHEMA_LOADED = true;
    }
  })();

  return TABLE_SCHEMA_PROMISE;
}

const USER_PREFIX = 'USER#';
const FRIEND_PREFIX = 'FRIEND#';
const BLOCK_PREFIX = 'BLOCK#';
const REPORT_PREFIX = 'REPORT#';
const METADATA_SK = 'METADATA';
const TTL_ATTRIBUTE = 'expiresAt';

function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  return email.trim().toLowerCase();
}

function normalizeAuthType(value) {
  if (value == null) return null;
  const authType = String(value).trim();
  if (!authType) return null;
  const normalized = authType.toUpperCase();
  const allowedTypes = ['MAIL', 'LOCAL', 'GUEST'];
  return allowedTypes.includes(normalized) ? normalized : null;
}

function buildProfileImageFields(user) {
  const profileImageUrl = normalizeProfileImageReference(user.profileImageUrl);
  const profileImagePath = normalizeProfileImageReference(user.profileImagePath);
  const safeProfileImageUrl = resolveProfileImageReference({ profileImageUrl, profileImagePath });
  const safeProfileImagePath = profileImagePath || safeProfileImageUrl || null;

  // Only output canonical fields matching the frontend model
  return {
    profileImageUrl: safeProfileImageUrl || null,
    profileImagePath: safeProfileImagePath || null,
  };
}

function buildItemKey(prefix, id, sk = METADATA_SK) {
  const key = {};
  const hashValue = prefix === USER_PREFIX && TABLE_HASH_KEY === 'userId' ? id : `${prefix}${id}`;
  key[TABLE_HASH_KEY] = hashValue;
  if (TABLE_HAS_SORT_KEY) {
    key[TABLE_RANGE_KEY] = sk;
  }
  return key;
}

function buildUserPrimaryKey(userId) {
  return buildItemKey(USER_PREFIX, userId);
}

function toIso(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    return new Date(value).toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const numeric = Number(value);
  return Number.isNaN(numeric) ? null : new Date(numeric).toISOString();
}

function shouldPreserveProtectedField(field, value) {
  if (value === undefined) return true;
  if (field === 'email' || field === 'passwordHash' || field === 'userId' || field === 'PK' || field === 'SK' || field === 'itemType' || field === 'createdAt') {
    if (value === null) return true;
    if (typeof value === 'string' && value.trim().length === 0) return true;
    return true;
  }
  return false;
}

function isDisallowedUserField(field) {
  return field === 'emailLower' || field === 'userNameLower' || field === 'normalizedEmail' || field === 'normalizedUserName';
}

function sanitizeUserUpdates(updates = {}) {
  const sanitized = {};
  Object.entries(updates).forEach(([field, value]) => {
    // Never allow callers to set protected or derived/internal fields
    if (isDisallowedUserField(field) || shouldPreserveProtectedField(field, value)) {
      return;
    }

    // Prevent callers from explicitly setting `updatedAt` — this is managed
    // by the persistence layer to avoid UpdateExpression conflicts.
    if (field === 'updatedAt') return;

    // Normalize Date-like values to ISO strings so DynamoDB marshalling
    // doesn't receive raw Date instances which cause errors.
    if (value instanceof Date) {
      sanitized[field] = value.toISOString();
      return;
    }

    if (typeof value === 'number' && !Number.isNaN(value)) {
      // Treat numeric timestamps as milliseconds since epoch
      try {
        const iso = new Date(value).toISOString();
        sanitized[field] = iso;
        return;
      } catch (e) {
        // Fall through to assign raw value below
      }
    }

    sanitized[field] = value;
  });
  return sanitized;
}

function buildUserItem(user) {
  if (!user || !user.userId) {
    throw new Error('User item requires userId');
  }

  const emailValue = user.email ? String(user.email).trim() : null;
  const normalizedEmail = normalizeEmail(emailValue);
  const now = new Date().toISOString();
  const createdAt = toIso(user.createdAt) || now;
  const updatedAt = toIso(user.updatedAt) || now;
  const lastLogin = toIso(user.lastLogin) || now;
  const origStatusUpdatedAt = user.statusUpdatedAt ? toIso(user.statusUpdatedAt) : (user.status ? now : null);
  const emailVerifiedAt = user.emailVerifiedAt ? toIso(user.emailVerifiedAt) : null;
  const birthDate = toIso(user.birthDate) || null;

  const authType = normalizeAuthType(user.authType) ??
    (Boolean(user.isGuest)
      ? 'GUEST'
      : user.passwordHash
        ? 'MAIL'
        : normalizedEmail
          ? 'MAIL'
          : 'LOCAL');

  const displayName = user.userName || user.name || user.displayName || 'User';
  const normalizedFriendRequests = Array.isArray(user.friendRequests)
    ? user.friendRequests.map((request) => {
        const senderId = request.senderId || request.userId || request.fromUserId || '';
        const receiverId = request.receiverId || request.recipientId || request.targetUserId || request.toUserId || '';
        const sender = request.sender && typeof request.sender === 'object' ? request.sender : null;
        const receiver = request.receiver && typeof request.receiver === 'object'
          ? request.receiver
          : (request.to && typeof request.to === 'object' ? request.to : null);
        const senderProfileImageUrl = resolveProfileImageReference(sender);
        const receiverProfileImageUrl = resolveProfileImageReference(receiver);
        const baseRequestId = request.requestId || request.id;
        const computedRequestId = baseRequestId || `req_${(request.createdAt ? new Date(request.createdAt).getTime() : Date.now())}_${crypto.randomBytes(6).toString('hex')}`;
        return {
          ...request,
          requestId: computedRequestId,
          status: request.status || 'pending',
          senderId,
          receiverId,
          sender: sender
            ? {
                userId: sender.userId || sender.id || senderId || null,
                id: sender.id || sender.userId || senderId || null,
                userName: sender.userName || sender.user_name || sender.displayName || sender.name || '',
                profileImageUrl: senderProfileImageUrl || null,
              }
            : (senderId ? { userId: senderId, id: senderId, profileImageUrl: null } : null),
          receiver: receiver
            ? {
                userId: receiver.userId || receiver.id || receiverId || null,
                id: receiver.id || receiver.userId || receiverId || null,
                userName: receiver.userName || receiver.user_name || receiver.displayName || receiver.name || '',
                profileImageUrl: receiverProfileImageUrl || null,
              }
            : (receiverId ? { userId: receiverId, id: receiverId, profileImageUrl: null } : null),
        };
      })
    : [];

  // Support new `status` object model: { statusNote: [...], statusMedia: [...] }
  let statusArrayNormalized = [];
  const statusObject = user.status && typeof user.status === 'object' && !Array.isArray(user.status)
    ? user.status
    : null;
  if (Array.isArray(user.status)) {
    statusArrayNormalized = normalizeStatusList(user.status);
  } else if (statusObject && Array.isArray(statusObject.statusNote)) {
    statusArrayNormalized = normalizeStatusList(statusObject.statusNote);
  }

  const statusMediaNormalized = (statusObject && Array.isArray(statusObject.statusMedia))
    ? statusObject.statusMedia
    : (Array.isArray(user.statusMedia) ? user.statusMedia : []);
  const statusNoteFromUser = user.statusNote && typeof user.statusNote === 'object'
    ? user.statusNote
    : (statusObject && (typeof statusObject.statusNote === 'object' || Array.isArray(statusObject.statusNote))
      ? statusObject.statusNote
      : statusObject);

  let statusNote = null;
  let statusText = null;
  let statusUpdatedAt = origStatusUpdatedAt;

  if (statusArrayNormalized.length) {
    const latest = pickLatestStatus(statusArrayNormalized);
    if (latest) {
      statusNote = {
        note: latest.note != null ? String(latest.note).trim() : null,
        color: latest.color != null ? String(latest.color).trim() : null,
      };
      statusText = statusNote.note || null;
      statusUpdatedAt = latest.createdAt || statusUpdatedAt;
    }
  } else {
    statusNote = statusNoteFromUser
      ? {
          note: statusNoteFromUser.note != null ? String(statusNoteFromUser.note).trim() : null,
          color: statusNoteFromUser.color != null ? String(statusNoteFromUser.color).trim() : null,
        }
      : null;
    statusText = statusNote?.note || (typeof user.status === 'string' ? String(user.status).trim() : null) || null;
    if (statusNote && !statusUpdatedAt) {
      statusUpdatedAt = now;
    }
  }

  const nestedStatus = {};
  if (statusArrayNormalized.length) nestedStatus.statusNote = statusArrayNormalized;
  if (Array.isArray(statusMediaNormalized) && statusMediaNormalized.length) nestedStatus.statusMedia = statusMediaNormalized;
  if (!Object.keys(nestedStatus).length && statusText) {
    nestedStatus.statusNote = [{ note: statusText, color: statusNote?.color || null, createdAt: statusUpdatedAt || null }];
  }

  const item = {
    ...buildItemKey(USER_PREFIX, user.userId),
    itemType: 'USER',
    userId: String(user.userId),
    userName: displayName,
    email: emailValue,
    authType,
    isGuest: Boolean(user.isGuest),
    gender: user.gender || 'other',
    country: user.country || null,
    status: Object.keys(nestedStatus).length ? nestedStatus : (statusText ? { statusNote: [{ note: statusText, color: null, createdAt: now }] } : { statusNote: [], statusMedia: [] }),
    bio: user.bio || null,
    interests: Array.isArray(user.interests) ? user.interests : [],
    birthDate,
    avatarColor: user.avatarColor || '#128C7E',
    avatarLetter: user.avatarLetter || (user.userName ? user.userName.charAt(0).toUpperCase() : 'U'),
    useColorProfile: user.useColorProfile !== undefined ? Boolean(user.useColorProfile) : true,
    hasProfileChanged: Boolean(user.hasProfileChanged),
    isFriend: Boolean(user.isFriend),
    isOnline: Boolean(user.isOnline),
    ...buildProfileImageFields(user),
    pictureName: user.pictureName || null,
    friendRequests: normalizedFriendRequests,
    passwordHash: user.passwordHash || null,
    emailVerified: Boolean(user.emailVerified),
    emailVerifiedAt,
    isActive: user.isActive !== false,
    xp: typeof user.xp === 'object' && user.xp !== null ? user.xp : {},
    likedUserIds: Array.isArray(user.likedUserIds) ? user.likedUserIds : [],
    lastDailyXpAwardedAt: toIso(user.lastDailyXpAwardedAt) || null,
    friends: Array.isArray(user.friends) ? user.friends : [],
    createdAt,
    updatedAt,
    lastLogin,
  };

  // Persist email normalization fields for efficient lookups and indexing.
  // emailLower is retained for backward compatibility with legacy records.
  if (normalizedEmail) {
    item.normalizedEmail = normalizedEmail;
    item.emailLower = normalizedEmail;
  }

  if (user.expiresAt) {
    const expiry = user.expiresAt instanceof Date ? Math.floor(user.expiresAt.getTime() / 1000) : Number(user.expiresAt);
    if (!Number.isNaN(expiry)) item[TTL_ATTRIBUTE] = expiry;
  }

  return item;
}

// The `normalizeIsoTimestamp` helper was removed because duplicate
// normalization logic exists elsewhere and the function was unused.

function normalizeIdValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function buildBlockItem(userId, blockedByUserId, data = {}) {
  const blockedUntil = data.blockedUntil ? toIso(data.blockedUntil) : null;
  const expiresAt = data.expiresAt ? (data.expiresAt instanceof Date ? Math.floor(data.expiresAt.getTime() / 1000) : Number(data.expiresAt)) : null;

  const item = {
    ...buildItemKey(BLOCK_PREFIX, userId, `${BLOCK_PREFIX}${blockedByUserId}`),
    itemType: 'BLOCK',
    userId,
    blockedByUserId,
    blockType: data.blockType || 'report',
    reason: data.reason || 'User reported',
    blockDuration: data.blockDuration || null,
    blockedUntil,
    reportCount: Number(data.reportCount) || 1,
    reporters: Array.isArray(data.reporters) ? data.reporters : [blockedByUserId],
    createdAt: toIso(data.createdAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (expiresAt && !Number.isNaN(expiresAt)) {
    item[TTL_ATTRIBUTE] = expiresAt;
  }
  return item;
}

function buildReportItem(reportedUserId, reporterId, reason = 'User reported') {
  return {
    ...buildItemKey(REPORT_PREFIX, reportedUserId, `${REPORT_PREFIX}${reporterId}`),
    itemType: 'REPORT',
    reportedUserId,
    reporterId,
    reason,
    createdAt: new Date().toISOString(),
  };
}

async function describeTable() {
  return client.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
}

async function isDbConnected() {
  if (USE_DEV_STORE) return true;
  try {
    await describeTable();
    return true;
  } catch (err) {
    return false;
  }
}

async function getUserById(userId) {
  if (!userId) return null;
  await loadTableSchema();
  if (USE_DEV_STORE) {
    const items = loadDevStore();
    const found = items.find((it) => it.itemType === 'USER' && String(it.userId) === String(userId));
    return normalizeDdbItem(found || null);
  }

  const key = buildUserPrimaryKey(userId);
  const result = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  return normalizeDdbItem(result.Item || null);
}

async function getUserByEmail(email) {
  const normalized = normalizeEmail(email);
  Logger.debug('dynamoDBService', 'getUserByEmail called', { rawEmail: email, normalized });
  if (!normalized) return null;

  if (USE_DEV_STORE) {
    const items = loadDevStore();
    const found = items.find((it) => it.itemType === 'USER' && it.email && String(it.email).trim().toLowerCase() === normalized);
    if (found) return normalizeDdbItem(found);

    return null;
  }

  await loadTableSchema();

  // Try the normalized attribute via EmailIndex first (if available).
  if (EMAIL_INDEX_AVAILABLE == null) {
    try {
      const result = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'EmailIndex',
        KeyConditionExpression: 'normalizedEmail = :normalizedEmail',
        ExpressionAttributeValues: {
          ':normalizedEmail': normalized,
        },
        Limit: 1,
      }));

      EMAIL_INDEX_AVAILABLE = true;
      Logger.debug('dynamoDBService', 'EmailIndex appears available (initial probe)', { email: normalized });
      if (result.Items && result.Items.length) {
        return normalizeDdbItem(result.Items[0]);
      }
    } catch (err) {
      EMAIL_INDEX_AVAILABLE = false;
      Logger.warn('dynamoDBService', 'EmailIndex query failed; falling back to scan', {
        email: normalized,
        error: err?.message || err,
      });
    }
  }

  if (EMAIL_INDEX_AVAILABLE == true) {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'EmailIndex',
      KeyConditionExpression: 'normalizedEmail = :normalizedEmail',
      ExpressionAttributeValues: {
        ':normalizedEmail': normalized,
      },
      Limit: 1,
    }));

    Logger.debug('dynamoDBService', 'EmailIndex query executed (cached available)', { email: normalized, items: result.Items && result.Items.length });

    if (result.Items && result.Items.length) {
      return normalizeDdbItem(result.Items[0]);
    }
  }

  // Scan fallback: check normalizedEmail, legacy emailLower, or email field.
  const scan = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'normalizedEmail = :e OR emailLower = :e OR email = :e',
    ExpressionAttributeValues: { ':e': normalized },
    Limit: 1,
  }));

  Logger.debug('dynamoDBService', 'Scan fallback executed', { email: normalized, items: scan.Items && scan.Items.length });

  if (scan.Items && scan.Items.length) {
    return normalizeDdbItem(scan.Items[0]);
  }

  // Additional legacy fallback: some old records may only store email with
  // case-sensitive casing and no normalized/emailLower fields. Scan for the
  // matching email in a case-insensitive way.
  if (normalized) {
    let lastEvaluatedKey = null;
    do {
      const legacyScan = await ddb.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'attribute_exists(email)',
        ExclusiveStartKey: lastEvaluatedKey || undefined,
        ProjectionExpression: 'userId, email, emailLower, normalizedEmail, passwordHash',
      }));

      if (legacyScan.Items && legacyScan.Items.length) {
        const legacyUser = legacyScan.Items.find((item) =>
          item.email && String(item.email).trim().toLowerCase() === normalized,
        );
        if (legacyUser) {
          Logger.warn('dynamoDBService', 'Legacy email fallback matched user by case-insensitive email', { email: normalized, userId: legacyUser.userId });
          return normalizeDdbItem(legacyUser);
        }
      }

      lastEvaluatedKey = legacyScan.LastEvaluatedKey;
    } while (lastEvaluatedKey);
  }

  return null;
}

async function findUserByLookup(lookup) {
  if (!lookup || typeof lookup !== 'object') return null;

  Logger.debug('dynamoDBService', 'findUserByLookup called', { lookup });

  if (lookup.userId) {
    return getUserById(String(lookup.userId).trim());
  }

  if (lookup.email) {
    return getUserByEmail(lookup.email);
  }

  if (Array.isArray(lookup.$or)) {
    for (const clause of lookup.$or) {
      if (clause.userId) {
        const user = await getUserById(String(clause.userId).trim());
        if (user) return user;
      }
      if (clause.email) {
        if (typeof clause.email === 'string') {
          const user = await getUserByEmail(clause.email);
          if (user) return user;
        } else if (typeof clause.email === 'object' && clause.email.$regex) {
          const regexValue = String(clause.email.$regex);
          const strippedRegex = regexValue.replace(/^\^/, '').replace(/\$$/, '');
          const normalizedEmail = strippedRegex.replace(/\\(.)/g, '$1');
          const user = await getUserByEmail(normalizedEmail);
          if (user) return user;
        }
      }
    }
  }

  const scanFilters = [];
  const expressionValues = {};

  if (lookup.userId) {
    scanFilters.push('userId = :userId');
    expressionValues[':userId'] = String(lookup.userId).trim();
  }
  if (lookup.email) {
    scanFilters.push('normalizedEmail = :normalizedEmail');
    expressionValues[':normalizedEmail'] = normalizeEmail(lookup.email);
  }

  if (!scanFilters.length) return null;

  const result = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: scanFilters.join(' AND '),
    ExpressionAttributeValues: expressionValues,
    Limit: 1,
  }));

  return result.Items && result.Items.length ? normalizeDdbItem(result.Items[0]) : null;
}

function normalizeDdbItem(item) {
  if (!item) return item;
  const normalized = { ...item };
  if (!TABLE_HAS_SORT_KEY && item.userId && !item.PK) {
    normalized.PK = item.userId;
    normalized.SK = METADATA_SK;
  }
  return normalized;
}

async function upsertUser(userData) {
  if (!userData || !userData.userId) {
    throw new Error('User data must include userId');
  }

  await loadTableSchema();
  if (USE_DEV_STORE) {
    const items = loadDevStore();
    const existing = items.find((u) => u.itemType === 'USER' && String(u.userId) === String(userData.userId));

    if (userData.email) {
      const emailCollisionUser = items.find((u) => u.itemType === 'USER' && u.email && String(u.email).trim().toLowerCase() === normalizeEmail(userData.email));
      if (emailCollisionUser && emailCollisionUser.userId !== userData.userId) {
        throw new Error('EMAIL_CONFLICT');
      }
    }

    let user = existing ? { ...existing, ...userData } : { ...userData };

    if (!existing) {
      const emailValue = user.email ? String(user.email).trim() : null;
      user = {
        ...user,
        authType: normalizeAuthType(user.authType) ?? (Boolean(user.isGuest) ? 'GUEST' : (user.passwordHash ? 'MAIL' : (emailValue ? 'MAIL' : 'LOCAL'))),
        isGuest: Boolean(user.isGuest),
        userName: user.userName || 'User',
        profileComplete: Boolean(user.profileComplete),
        isActive: user.isActive !== false,
        email: emailValue,
        createdAt: toIso(user.createdAt) || new Date().toISOString(),
        lastLogin: toIso(user.lastLogin) || new Date().toISOString(),
      };
    }

    const item = buildUserItem(user);
    // remove SK for hash-only tables in dev store representation
    if (!TABLE_HAS_SORT_KEY) delete item.SK;

    // upsert into dev store
    const filtered = items.filter((u) => !(u.itemType === 'USER' && String(u.userId) === String(item.userId)));
    filtered.push(item);
    saveDevStore(filtered);
    return normalizeDdbItem(item);
  }

  const existing = await getUserById(userData.userId);

  if (userData.email) {
    const emailCollisionUser = await getUserByEmail(userData.email);
    if (emailCollisionUser && emailCollisionUser.userId !== userData.userId) {
      throw new Error('EMAIL_CONFLICT');
    }
  }

  let user = existing ? { ...existing, ...userData } : { ...userData };

  if (!existing) {
    const emailValue = user.email ? String(user.email).trim() : null;
    const hasEmail = !!emailValue;
    user = {
      ...user,
      authType: normalizeAuthType(user.authType) ??
        (Boolean(user.isGuest)
          ? 'GUEST'
          : user.passwordHash
            ? 'MAIL'
            : hasEmail
              ? 'MAIL'
              : 'LOCAL'),
      isGuest: Boolean(user.isGuest),
      userName: user.userName || 'User',
      profileComplete: Boolean(user.profileComplete),
      isActive: user.isActive !== false,
      email: emailValue,
      createdAt: toIso(user.createdAt) || new Date().toISOString(),
      lastLogin: toIso(user.lastLogin) || new Date().toISOString(),
    };
  }

  const item = buildUserItem(user);
  if (!TABLE_HAS_SORT_KEY) {
    delete item.SK;
  }

  // If this is a new user (no existing), perform a conditional Put so we do
  // not accidentally overwrite an existing DB record created concurrently
  // by another process. If the condition fails, read and return the
  // existing item to avoid creating a lightweight placeholder that would
  // drop real profile fields.
  if (!existing) {
    const putParams = {
      TableName: TABLE_NAME,
      Item: item,
      // Condition: the partition key must not already exist
      ConditionExpression: `attribute_not_exists(${TABLE_HASH_KEY})`,
    };
    // If table has sort key, also ensure the SK doesn't exist (safeguard)
    if (TABLE_HAS_SORT_KEY && TABLE_RANGE_KEY) {
      putParams.ConditionExpression = `attribute_not_exists(${TABLE_HASH_KEY}) AND attribute_not_exists(${TABLE_RANGE_KEY})`;
    }

    try {
      await ddb.send(new PutCommand(putParams));
      return item;
    } catch (err) {
      // If conditional check fails, read the current item and return it
      if (err && err.name === 'ConditionalCheckFailedException') {
        const current = await getUserById(userData.userId);
        return current || item;
      }
      throw err;
    }
  }

  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

async function createUser(userData) {
  if (!userData || !userData.userId) {
    throw new Error('User data must include userId');
  }

  // Email is required for non-guest users
  const isGuest = Boolean(userData.isGuest);
  if (!isGuest && (!userData.email || String(userData.email).trim().length === 0)) {
    throw new Error('Email is required for non-guest users');
  }

  await loadTableSchema();
  if (USE_DEV_STORE) {
    const items = loadDevStore();
    const existingById = items.find((u) => u.itemType === 'USER' && String(u.userId) === String(userData.userId));
    if (existingById) throw new Error('USER_EXISTS');
    if (userData.email) {
      const existingByEmail = items.find((u) => u.itemType === 'USER' && u.email && String(u.email).trim().toLowerCase() === normalizeEmail(userData.email));
      if (existingByEmail) throw new Error('USER_EXISTS');
    }
    const item = buildUserItem(userData);
    if (!TABLE_HAS_SORT_KEY) delete item.SK;
    items.push(item);
    saveDevStore(items);
    return normalizeDdbItem(item);
  }

  const existingById = await getUserById(userData.userId);
  if (existingById) {
    throw new Error('USER_EXISTS');
  }

  if (userData.email) {
    const existingByEmail = await getUserByEmail(userData.email);
    if (existingByEmail) {
      throw new Error('USER_EXISTS');
    }
  }

  const item = buildUserItem(userData);
  if (!TABLE_HAS_SORT_KEY) {
    delete item.SK;
  }

  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

async function updateUserById(userId, updates) {
  const current = await getUserById(userId);
  if (!current) return null;

  const safeUpdates = sanitizeUserUpdates(updates);

  if (USE_DEV_STORE) {
    const items = loadDevStore();
    if (safeUpdates.email) {
      const normalizedEmail = normalizeEmail(safeUpdates.email);
      const existingByEmail = items.find((u) => u.itemType === 'USER' && u.email && String(u.email).trim().toLowerCase() === normalizedEmail && String(u.userId) !== String(userId));
      if (existingByEmail) throw new Error('EMAIL_CONFLICT');
    }

    const now = new Date().toISOString();
    const merged = { ...current, ...safeUpdates, updatedAt: now };

    if (safeUpdates.email) {
      const emailValue = safeUpdates.email ? String(safeUpdates.email).trim() : null;
      merged.email = emailValue;
      merged.normalizedEmail = normalizeEmail(emailValue);
      merged.emailLower = merged.normalizedEmail;
    }

    // Preserve any existing custom or legacy fields on the USER record when
    // updating the JSON dev store. Avoid rebuilding the item schema from scratch
    // because that can drop fields like notifications, pendingIncomingRequests,
    // pendingOutgoingRequests, or other derived data.
    merged.userId = String(userId);
    merged.itemType = 'USER';
    merged.PK = current.PK || buildItemKey(USER_PREFIX, userId).PK;
    if (TABLE_HAS_SORT_KEY) merged.SK = current.SK || METADATA_SK;

    const filtered = items.filter((u) => !(u.itemType === 'USER' && String(u.userId) === String(userId)));
    filtered.push(merged);
    saveDevStore(filtered);
    return normalizeDdbItem(merged);
  }

  if (safeUpdates.email) {
    const normalizedEmail = normalizeEmail(safeUpdates.email);
    const existingByEmail = await getUserByEmail(normalizedEmail);
    if (existingByEmail && existingByEmail.userId !== userId) {
      throw new Error('EMAIL_CONFLICT');
    }
  }

  // Build a non-destructive UpdateCommand so we don't accidentally overwrite
  // the entire user item when only a few attributes need changing. This
  // preserves any attributes not present in `safeUpdates`.
  const key = buildUserPrimaryKey(userId);

  const exprNames = {};
  const exprValues = {};
  const setParts = [];

  // If email is being updated, also persist normalizedEmail and emailLower for index lookups
  if (safeUpdates.email) {
    const emailValue = safeUpdates.email ? String(safeUpdates.email).trim() : null;
    exprNames['#email'] = 'email';
    exprValues[':email'] = emailValue;
    setParts.push('#email = :email');

    const normalizedEmail = normalizeEmail(emailValue);
    exprNames['#normalizedEmail'] = 'normalizedEmail';
    exprValues[':normalizedEmail'] = normalizedEmail;
    setParts.push('#normalizedEmail = :normalizedEmail');

    exprNames['#emailLower'] = 'emailLower';
    exprValues[':emailLower'] = normalizedEmail;
    setParts.push('#emailLower = :emailLower');
  }

  // Map other safe updates to SET expressions. Allow null values to be written
  // explicitly so callers can clear attributes (e.g. profileImageUrl = null).
  Object.entries(safeUpdates).forEach(([field, value]) => {
    if (field === 'email') return; // already handled above
    const nameKey = `#${field}`;
    const valKey = `:${field}`;
    exprNames[nameKey] = field;
    exprValues[valKey] = value;
    setParts.push(`${nameKey} = ${valKey}`);
  });

  // Always update updatedAt to indicate mutation
  exprNames['#updatedAt'] = 'updatedAt';
  exprValues[':now'] = new Date().toISOString();
  setParts.push('#updatedAt = :now');

  const updateExpression = setParts.length ? `SET ${setParts.join(', ')}` : undefined;

  const params = {
    TableName: TABLE_NAME,
    Key: key,
    ReturnValues: 'ALL_NEW',
  };
  if (updateExpression) params.UpdateExpression = updateExpression;
  if (Object.keys(exprNames).length) params.ExpressionAttributeNames = exprNames;
  if (Object.keys(exprValues).length) params.ExpressionAttributeValues = exprValues;

  const result = await ddb.send(new UpdateCommand(params));
  const updatedItem = result.Attributes ? normalizeDdbItem(result.Attributes) : await getUserById(userId);
  return updatedItem;
}

async function deleteUserById(userId) {
  if (!userId) return null;
  if (USE_DEV_STORE) {
    const items = loadDevStore();
    const key = buildItemKey(USER_PREFIX, userId);
    const filtered = items.filter((it) => {
      if (!it || !it.PK) return true;
      if (TABLE_HAS_SORT_KEY && key[TABLE_RANGE_KEY]) {
        return !(String(it.PK) === String(key[TABLE_HASH_KEY]) && String(it.SK) === String(key[TABLE_RANGE_KEY]));
      }
      return String(it.PK) !== String(key[TABLE_HASH_KEY]);
    });
    saveDevStore(filtered);
    return true;
  }

  if (!ddb) throw new Error('DynamoDB client unavailable');
  return ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: buildItemKey(USER_PREFIX, userId) }));
}

async function searchUsers(query, limit = 25) {
  const queryLower = String(query || '').trim().toLowerCase();
  if (!queryLower) return [];
  const expressionValues = {
    ':userType': 'USER',
  };

  if (USE_DEV_STORE) {
    const items = loadDevStore();
    const found = items.filter((it) => it.itemType === 'USER' && (() => {
      const name = String(it.userName || '').toLowerCase();
      const email = String(it.email || '').toLowerCase();
      const id = String(it.userId || '').toLowerCase();
      return name.includes(queryLower) || email.includes(queryLower) || id.includes(queryLower);
    })()).slice(0, limit).map(normalizeDdbItem);
    return found;
  }
  // Paginated scan with client-side filtering to avoid relying on legacy
  // `userNameLower` / `emailLower` attributes which may not be present.
  const projection = 'userId, userName, email, gender, country, #status, bio, interests, avatarColor, avatarLetter, profileImageUrl, profileImagePath, authType, isGuest, isOnline, createdAt, lastLogin, xp, itemType';
  const expressionNames = { '#status': 'status' };

  const matches = [];
  let ExclusiveStartKey = null;
  do {
    const params = {
      TableName: TABLE_NAME,
      ProjectionExpression: projection,
      ExpressionAttributeNames: expressionNames,
      Limit: 1000,
    };
    if (ExclusiveStartKey) params.ExclusiveStartKey = ExclusiveStartKey;

    const page = await ddb.send(new ScanCommand(params));
    const items = (page.Items || []).map(normalizeDdbItem);

    for (const it of items) {
      const name = String(it.userName || '').toLowerCase();
      const email = String(it.email || '').toLowerCase();
      const id = String(it.userId || '').toLowerCase();
      if (name.includes(queryLower) || email.includes(queryLower) || id.includes(queryLower)) {
        matches.push(it);
        if (matches.length >= limit) break;
      }
    }

    ExclusiveStartKey = page.LastEvaluatedKey || null;
  } while (ExclusiveStartKey && matches.length < limit);

  return matches.slice(0, limit);
}

async function clearExpiredStatuses(cutoffIso) {
  // Scan users that have nested status payloads or a legacy single status value.
  const result = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'itemType = :userType AND attribute_exists(#status)',
    ExpressionAttributeNames: {
      '#status': 'status',
      '#statusUpdatedAt': 'statusUpdatedAt',
    },
    ExpressionAttributeValues: {
      ':userType': 'USER',
      ':cutoff': cutoffIso,
    },
    ProjectionExpression: 'PK, SK, #status, #statusUpdatedAt',
  }));

  if (!result.Items || !result.Items.length) return 0;

  const cutoffDate = new Date(cutoffIso);
  const updatePromises = result.Items.map(async (item) => {
    const key = { PK: item.PK, SK: item.SK };

    // If the item has a nested status payload, filter out old entries.
    const statusPayload = item.status && typeof item.status === 'object' && !Array.isArray(item.status)
      ? item.status
      : null;
    const originalEntries = Array.isArray(statusPayload?.statusNote)
      ? statusPayload.statusNote.slice()
      : [];

    if (originalEntries.length) {
      const filtered = originalEntries.filter((entry) => {
        if (!entry) return false;
        if (!entry.createdAt) return false; // treat unknown age as expired
        const dt = new Date(entry.createdAt);
        return !Number.isNaN(dt.getTime()) && dt >= cutoffDate;
      });

      if (filtered.length === originalEntries.length) {
        if (item.status && item.statusUpdatedAt && new Date(item.statusUpdatedAt) < cutoffDate) {
          return ddb.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: key,
            UpdateExpression: 'REMOVE #status, #statusUpdatedAt',
            ExpressionAttributeNames: { '#status': 'status', '#statusUpdatedAt': 'statusUpdatedAt' },
          }));
        }
        return null;
      }

      if (filtered.length === 0) {
        return ddb.send(new UpdateCommand({
          TableName: TABLE_NAME,
          Key: key,
          UpdateExpression: 'REMOVE #status, #statusUpdatedAt',
          ExpressionAttributeNames: { '#status': 'status', '#statusUpdatedAt': 'statusUpdatedAt' },
        }));
      }

      const latest = pickLatestStatus(filtered);
      const newStatusPayload = {
        ...(Array.isArray(statusPayload?.statusMedia) && statusPayload.statusMedia.length ? { statusMedia: statusPayload.statusMedia } : {}),
        statusNote: filtered,
      };
      const newStatusNote = latest ? { note: latest.note || null, color: latest.color || null } : null;
      const newStatusUpdatedAt = latest && latest.createdAt ? latest.createdAt : null;

      return ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: key,
        UpdateExpression: 'SET #status = :s, #statusNote = :sn, #statusUpdatedAt = :su',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#statusNote': 'statusNote',
          '#statusUpdatedAt': 'statusUpdatedAt',
        },
        ExpressionAttributeValues: {
          ':s': newStatusPayload,
          ':sn': newStatusNote,
          ':su': newStatusUpdatedAt,
        },
      }));
    }

    // Fallback: single `status` value expired — remove it.
    if (item.status && item.statusUpdatedAt && new Date(item.statusUpdatedAt) < cutoffDate) {
      return ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: key,
        UpdateExpression: 'REMOVE #status, #statusUpdatedAt',
        ExpressionAttributeNames: { '#status': 'status', '#statusUpdatedAt': 'statusUpdatedAt' },
      }));
    }

    return null;
  });

  const results = await Promise.all(updatePromises);
  // Count non-null updates
  return results.filter(Boolean).length;
}

async function getUsersByIds(userIds) {
  if (!Array.isArray(userIds) || !userIds.length) {
    return [];
  }

  const uniqueUserIds = [...new Set(userIds.map((id) => String(id).trim()).filter(Boolean))];
  if (!uniqueUserIds.length) {
    return [];
  }

  if (USE_DEV_STORE) {
    const items = loadDevStore();
    const found = items
      .filter((it) => it.itemType === 'USER' && uniqueUserIds.includes(String(it.userId)))
      .map(normalizeDdbItem);
    const foundById = new Map(found.map((item) => [String(item.userId), item]));
    return uniqueUserIds.map((id) => foundById.get(id)).filter(Boolean);
  }

  const batchSize = 100;
  const results = [];

  for (let index = 0; index < uniqueUserIds.length; index += batchSize) {
    const batchIds = uniqueUserIds.slice(index, index + batchSize);
    const keys = batchIds.map((id) => buildItemKey(USER_PREFIX, id));
    const result = await ddb.send(new BatchGetCommand({
      RequestItems: {
        [TABLE_NAME]: {
          Keys: keys,
        },
      },
    }));

    const batchItems = result.Responses && result.Responses[TABLE_NAME]
      ? result.Responses[TABLE_NAME].map(normalizeDdbItem)
      : [];
    results.push(...batchItems);
  }

  const foundById = new Map(results.map((item) => [String(item.userId), item]));
  return uniqueUserIds.map((id) => foundById.get(id)).filter(Boolean);
}

async function getActiveBlock(userId) {
  if (!userId) return null;
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `${BLOCK_PREFIX}${userId}`,
    },
    Limit: 1,
  }));

  const block = result.Items && result.Items.length ? result.Items[0] : null;
  if (!block) return null;
  if (!block.blockedUntil) return block;
  const now = new Date().toISOString();
  if (block.blockedUntil <= now) {
    await deleteBlock(userId, block.blockedByUserId);
    return null;
  }
  return block;
}

async function putBlockedUser(blockData) {
  if (!blockData || !blockData.userId || !blockData.blockedByUserId) return null;
  const item = buildBlockItem(blockData.userId, blockData.blockedByUserId, blockData);
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

async function deleteBlock(userId, blockedByUserId) {
  if (!userId || !blockedByUserId) return null;
  return ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: buildItemKey(BLOCK_PREFIX, userId, `${BLOCK_PREFIX}${blockedByUserId}`) }));
}

async function getReportsForUser(reportedUserId) {
  if (!reportedUserId) return [];
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `${REPORT_PREFIX}${reportedUserId}`,
    },
  }));
  return (result.Items || []).map(normalizeDdbItem);
}

async function getReport(reportedUserId, reporterId) {
  if (!reportedUserId || !reporterId) return null;
  const result = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: buildItemKey(REPORT_PREFIX, reportedUserId, `${REPORT_PREFIX}${reporterId}`) }));
  return result.Item || null;
}

async function createReport(reportedUserId, reporterId, reason) {
  const item = buildReportItem(reportedUserId, reporterId, reason);
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

async function deleteReportsForUser(userId) {
  if (!userId) return 0;
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `${REPORT_PREFIX}${userId}`,
    },
  }));
  const deleteOps = (result.Items || []).map((item) =>
    ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: item.PK, SK: item.SK } }))
  );
  await Promise.all(deleteOps);
  return deleteOps.length;
}

async function deleteReportsByReporter(reporterId) {
  if (!reporterId) return 0;
  const scanResult = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'itemType = :reportType AND reporterId = :reporterId',
    ExpressionAttributeValues: {
      ':reportType': 'REPORT',
      ':reporterId': reporterId,
    },
    ProjectionExpression: 'PK, SK',
  }));
  const deleteOps = (scanResult.Items || []).map((item) =>
    ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: item.PK, SK: item.SK } }))
  );
  await Promise.all(deleteOps);
  return deleteOps.length;
}

async function deleteBlocksForUser(userId) {
  if (!userId) return 0;
  const outgoing = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `${BLOCK_PREFIX}${userId}` },
    ProjectionExpression: 'PK, SK',
  }));
  const scanResult = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'itemType = :blockType AND blockedByUserId = :userId',
    ExpressionAttributeValues: {
      ':blockType': 'BLOCK',
      ':userId': userId,
    },
    ProjectionExpression: 'PK, SK',
  }));
  const items = [...(outgoing.Items || []), ...(scanResult.Items || [])];
  const deleteOps = items.map((item) => ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: item.PK, SK: item.SK } })));
  await Promise.all(deleteOps);
  return deleteOps.length;
}

async function deleteReportsForUserAndReporter(userId) {
  const deletedReported = await deleteReportsForUser(userId);
  const deletedReporter = await deleteReportsByReporter(userId);
  return deletedReported + deletedReporter;
}

async function getUserStats() {
  return {
    table: TABLE_NAME,
    region: AWS_REGION,
    connected: await isDbConnected(),
  };
}

// ========== FRIEND REQUEST MANAGEMENT ==========
// Frontend model: FriendRef { friendId, addedAt }, FriendRequestModel { requestId, status, sender, receiver, ... }
// Backend storage: Separate FRIEND items for requests + bidirectional friend records on acceptance

async function createFriendRequest(userId, targetUserId, metadata = {}) {
  if (!userId || !targetUserId || userId === targetUserId) return null;
  if (!USE_DEV_STORE) await loadTableSchema();

  const baseRequestId = normalizeIdValue(metadata.requestId || metadata.id || '');
  const requestId = baseRequestId || `req_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  const now = new Date().toISOString();
  const rawSender = metadata.senderProfile || { userId, userName: metadata.userName || userId };
  const senderProfile = {
    userId: rawSender.userId || rawSender.id || userId,
    id: rawSender.id || rawSender.userId || userId,
    userName: rawSender.userName || rawSender.user_name || rawSender.displayName || rawSender.name || metadata.userName || '',
    profileImageUrl: normalizeProfileImageReference(resolveProfileImageReference(rawSender)),
  };
  const rawRecipient = metadata.recipientProfile || { userId: targetUserId, userName: metadata.recipientUserName || targetUserId };
  const recipientProfile = {
    userId: rawRecipient.userId || rawRecipient.id || targetUserId,
    id: rawRecipient.id || rawRecipient.userId || targetUserId,
    userName: rawRecipient.userName || rawRecipient.user_name || rawRecipient.displayName || rawRecipient.name || metadata.recipientUserName || '',
    profileImageUrl: normalizeProfileImageReference(resolveProfileImageReference(rawRecipient)),
  };

  const outgoingRequest = {
    requestId,
    status: 'pending',
    createdAt: now,
    requestType: 'FRIEND_REQUEST_OUTGOING',
    isRead: false,
    isIncoming: false,
    senderId: senderProfile.userId,
    receiverId: recipientProfile.userId,
    sender: senderProfile,
    receiver: recipientProfile,
  };

  const incomingRequest = {
    ...outgoingRequest,
    requestType: 'FRIEND_REQUEST_INCOMING',
    isIncoming: true,
    sender: senderProfile,
    receiver: recipientProfile,
  };

  const sender = await getUserById(userId);
  const recipient = await getUserById(targetUserId);
  if (!sender || !recipient) return null;

  const senderRequests = Array.isArray(sender.friendRequests) ? sender.friendRequests : [];
  const recipientRequests = Array.isArray(recipient.friendRequests) ? recipient.friendRequests : [];

  const nextSenderRequests = senderRequests.filter((request) => String(request.requestId) !== requestId);
  const nextRecipientRequests = recipientRequests.filter((request) => String(request.requestId) !== requestId);
  nextSenderRequests.push(outgoingRequest);
  nextRecipientRequests.push(incomingRequest);

  await updateUserById(userId, { friendRequests: nextSenderRequests });
  await updateUserById(targetUserId, { friendRequests: nextRecipientRequests });

  return outgoingRequest;
}

async function getFriendRequest(userId, targetUserId) {
  if (!userId || !targetUserId) return null;

  const normalizeId = (value) => String(value || '').trim();
  const expectedSender = normalizeId(userId);
  const expectedReceiver = normalizeId(targetUserId);
  const expectedRequestId = `${expectedSender}|${expectedReceiver}`;

  const matchesRequest = (item) => {
    if (!item || typeof item !== 'object') return false;

    const candidateRequestId = normalizeId(item.requestId || item.id || item._id || '');
    if (candidateRequestId && candidateRequestId === expectedRequestId) return true;

    const senderId = normalizeId(
      item.senderId ||
      item.userId ||
      item.fromUserId ||
      item.sender?.userId ||
      item.sender?.id ||
      '',
    );
    const receiverId = normalizeId(
      item.receiverId ||
      item.recipientId ||
      item.targetUserId ||
      item.toUserId ||
      item.receiver?.userId ||
      item.receiver?.id ||
      '',
    );

    return senderId === expectedSender && receiverId === expectedReceiver;
  };

  const recipient = await getUserById(targetUserId);
  if (recipient) {
    const request = (Array.isArray(recipient.friendRequests) ? recipient.friendRequests : []).find(matchesRequest);
    if (request) return request;
  }

  const sender = await getUserById(userId);
  if (!sender) return null;
  return (Array.isArray(sender.friendRequests) ? sender.friendRequests : []).find(matchesRequest) || null;
}

async function queryFriendRequestsForUser(userId, direction = 'incoming') {
  if (!userId) return [];

  const user = await getUserById(userId);
  if (!user) return [];

  const requests = Array.isArray(user.friendRequests) ? user.friendRequests : [];
  if (direction === 'incoming') {
    return requests.filter((item) => item && String(item.requestType || '').toUpperCase().includes('INCOMING') && String(item.status).toLowerCase() === 'pending');
  }

  return requests.filter((item) => item && String(item.requestType || '').toUpperCase().includes('OUTGOING') && String(item.status).toLowerCase() === 'pending');
}

function _matchesFriendRequest(request, requestId, userId, targetUserId) {
  const candidateId = String(request?.requestId || '').trim();
  if (candidateId && candidateId === requestId) return true;

  const sender = String(
    request?.senderId || request?.userId || request?.fromUserId || request?.sender?.userId || request?.sender?.id || '',
  ).trim();
  const receiver = String(
    request?.receiverId || request?.recipientId || request?.targetUserId || request?.friendId || request?.receiver?.userId || request?.receiver?.id || '',
  ).trim();

  return sender === String(userId).trim() && receiver === String(targetUserId).trim();
}

async function acceptFriendRequest(userId, targetUserId) {
  if (!userId || !targetUserId) return null;

  const requestId = `${String(userId)}|${String(targetUserId)}`;
  const now = new Date().toISOString();
  const sender = await getUserById(userId);
  const recipient = await getUserById(targetUserId);
  if (!sender || !recipient) return null;

  const senderRequests = Array.isArray(sender.friendRequests) ? sender.friendRequests : [];
  const recipientRequests = Array.isArray(recipient.friendRequests) ? recipient.friendRequests : [];

  const nextSenderRequests = senderRequests.filter(
    (request) => !_matchesFriendRequest(request, requestId, userId, targetUserId),
  );
  const nextRecipientRequests = recipientRequests.filter(
    (request) => !_matchesFriendRequest(request, requestId, userId, targetUserId),
  );

  const senderFriends = Array.isArray(sender.friends) ? sender.friends : [];
  const recipientFriends = Array.isArray(recipient.friends) ? recipient.friends : [];
  const senderFriendIds = senderFriends.map((friend) => String(friend.friendId));
  const recipientFriendIds = recipientFriends.map((friend) => String(friend.friendId));

  const senderHasFriend = senderFriendIds.includes(String(targetUserId));
  const recipientHasFriend = recipientFriendIds.includes(String(userId));

  const nextSenderFriends = senderHasFriend ? senderFriends : [...senderFriends, { friendId: targetUserId, addedAt: now }];
  const nextRecipientFriends = recipientHasFriend ? recipientFriends : [...recipientFriends, { friendId: userId, addedAt: now }];
  const nextSenderFriendIds = nextSenderFriends.map((friend) => String(friend.friendId)).filter(Boolean);
  const nextRecipientFriendIds = nextRecipientFriends.map((friend) => String(friend.friendId)).filter(Boolean);

  await updateUserById(userId, {
    friendRequests: nextSenderRequests,
    friends: nextSenderFriends,
    friendIds: nextSenderFriendIds,
  });
  await updateUserById(targetUserId, {
    friendRequests: nextRecipientRequests,
    friends: nextRecipientFriends,
    friendIds: nextRecipientFriendIds,
  });

  return { requestId, status: 'accepted' };
}

async function denyFriendRequest(userId, targetUserId) {
  if (!userId || !targetUserId) return null;

  const requestId = `${String(userId)}|${String(targetUserId)}`;
  const sender = await getUserById(userId);
  const recipient = await getUserById(targetUserId);
  if (!sender || !recipient) return false;

  const nextSenderRequests = (Array.isArray(sender.friendRequests) ? sender.friendRequests : []).filter(
    (request) => !_matchesFriendRequest(request, requestId, userId, targetUserId),
  );
  const nextRecipientRequests = (Array.isArray(recipient.friendRequests) ? recipient.friendRequests : []).filter(
    (request) => !_matchesFriendRequest(request, requestId, userId, targetUserId),
  );

  await updateUserById(userId, { friendRequests: nextSenderRequests });
  await updateUserById(targetUserId, { friendRequests: nextRecipientRequests });
  return { requestId, status: 'rejected' };
}

async function removeFriend(userId, friendId) {
  if (!userId || !friendId) return null;

  const user = await getUserById(userId);
  const target = await getUserById(friendId);
  if (!user || !target) return false;

  const nextUserFriends = (Array.isArray(user.friends) ? user.friends : []).filter((friend) => String(friend.friendId) !== String(friendId));
  const nextTargetFriends = (Array.isArray(target.friends) ? target.friends : []).filter((friend) => String(friend.friendId) !== String(userId));
  const nextUserFriendIds = nextUserFriends.map((friend) => String(friend.friendId)).filter(Boolean);
  const nextTargetFriendIds = nextTargetFriends.map((friend) => String(friend.friendId)).filter(Boolean);

  await updateUserById(userId, {
    friends: nextUserFriends,
    friendIds: nextUserFriendIds,
  });
  await updateUserById(friendId, {
    friends: nextTargetFriends,
    friendIds: nextTargetFriendIds,
  });
  return true;
}

async function listFriends(userId) {
  if (!userId) return [];

  const user = await getUserById(userId);
  if (!user) return [];

  const friendIds = Array.isArray(user.friendIds) && user.friendIds.length
    ? user.friendIds
    : (Array.isArray(user.friends) ? user.friends.map((friend) => String(friend.friendId)) : []);
  return friendIds.map((friendId) => String(friendId));
}

module.exports = {
  isDbConnected,
  isDevStoreEnabled,
  getUserById,
  getUserByEmail,
  findUserByLookup,
  upsertUser,
  createUser,
  buildUserItem,
  updateUserById,
  deleteUserById,
  searchUsers,
  clearExpiredStatuses,
  getUsersByIds,
  getActiveBlock,
  putBlockedUser,
  deleteBlock,
  getReportsForUser,
  getReport,
  createReport,
  deleteBlocksForUser,
  deleteReportsForUserAndReporter,
  getUserStats,
  // Friend request management
  createFriendRequest,
  getFriendRequest,
  queryFriendRequestsForUser,
  acceptFriendRequest,
  denyFriendRequest,
  removeFriend,
  listFriends,
  clearDevStore,
  // Internal helpers (not exported): normalizeProfileImageReference, buildProfileImageFields
};
