const { DynamoDBClient, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
const fs = require('fs');
const path = require('path');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  BatchGetCommand,
  TransactWriteCommand,
} = require('@aws-sdk/lib-dynamodb');

const TABLE_NAME = process.env.DYNAMODB_TABLE || 'oververseDB';
const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';
const MAX_PROFILE_IMAGE_URL_LENGTH = 20000;
const MAX_INLINE_PROFILE_IMAGE_URL_LENGTH = 120 * 1024; // 120KB limit for persistent inline images

// Allow connecting to a local DynamoDB endpoint (DYNAMODB_ENDPOINT) for development/testing
const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT || process.env.AWS_ENDPOINT || null;
const clientOptions = { region: AWS_REGION };
if (DYNAMODB_ENDPOINT) clientOptions.endpoint = DYNAMODB_ENDPOINT;
const client = new DynamoDBClient(clientOptions);

function shouldUseDevStoreFallback() {
  if (process.env.USE_DEV_STORE === 'true') return true;
  if (DYNAMODB_ENDPOINT) return false;

  const hasExplicitAwsCredentials = Boolean(
    process.env.AWS_ACCESS_KEY_ID ||
    process.env.AWS_SECRET_ACCESS_KEY ||
    process.env.AWS_SESSION_TOKEN ||
    process.env.AWS_PROFILE ||
    process.env.AWS_DEFAULT_PROFILE ||
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
    process.env.AWS_ROLE_ARN
  );

  const hasAwsDeploymentHints = Boolean(
    process.env.DYNAMODB_TABLE ||
    process.env.AWS_REGION ||
    process.env.AWS_S3_BUCKET ||
    process.env.AWS_S3_PUBLIC_URL ||
    process.env.AWS_S3_PROFILE_FOLDER
  );

  const useDevStore = !hasExplicitAwsCredentials && !hasAwsDeploymentHints && process.env.NODE_ENV !== 'production';
  if (useDevStore) {
    console.warn('[dynamoDBService] Using local dev fallback store because no AWS credentials, no DynamoDB endpoint, and no AWS deployment hints were detected. Set USE_DEV_STORE=true to preserve this behavior or configure AWS credentials to use real DynamoDB.');
  }
  return useDevStore;
}

// Development fallback: simple JSON-backed store when running locally without DynamoDB.
// It is enabled automatically when no AWS credentials are present so local signup flows still persist data.
const USE_DEV_STORE = shouldUseDevStoreFallback();
const DEV_STORE_PATH = path.resolve(__dirname, '..', 'dev_dynamo_users.json');

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
const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
  unmarshallOptions: {
    convertEmptyValues: false,
  },
});

let TABLE_HASH_KEY = 'PK';
let TABLE_RANGE_KEY = 'SK';
let TABLE_HAS_SORT_KEY = true;
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

function normalizeProfileImageReference(value) {
  if (value == null) return null;
  const stringValue = String(value).trim();
  if (!stringValue) return null;
  if (stringValue.length > MAX_PROFILE_IMAGE_URL_LENGTH) return null;

  const lower = stringValue.toLowerCase();
  if (lower.startsWith('data:')) {
    return null;
  }

  if (lower.startsWith('/')) {
    return null;
  }

  if (lower.includes('upload') && !/^https?:\/\//i.test(stringValue)) {
    return null;
  }

  if (lower.startsWith('file:')) {
    return null;
  }

  if (lower.startsWith('c:')) {
    return null;
  }

  if (lower.startsWith('blob:')) {
    return null;
  }

  if (lower.startsWith('content:')) {
    return null;
  }

  if (lower.startsWith('app://')) {
    return null;
  }

  if (stringValue.length > MAX_INLINE_PROFILE_IMAGE_URL_LENGTH) {
    return null;
  }

  return stringValue;
}

function normalizeAuthType(value) {
  if (value == null) return null;
  const authType = String(value).trim();
  if (!authType) return null;
  const normalized = authType.toUpperCase();
  const allowedTypes = ['GOOGLE_OAUTH', 'MAIL', 'LOCAL', 'GUEST'];
  return allowedTypes.includes(normalized) ? normalized : null;
}

function buildProfileImageFields(user) {
  const profileImageUrl = normalizeProfileImageReference(user.profileImageUrl);
  const profileImagePath = normalizeProfileImageReference(user.profileImagePath);

  if (profileImageUrl && profileImagePath && profileImageUrl === profileImagePath) {
    return { profileImageUrl, profileImagePath: null };
  }

  return {
    profileImageUrl: profileImageUrl || profileImagePath || null,
    profileImagePath: profileImagePath || null,
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
  if (field === 'email' || field === 'emailLower' || field === 'passwordHash' || field === 'userId') {
    if (value === null) return true;
    if (typeof value === 'string' && value.trim().length === 0) return true;
  }
  return false;
}

function sanitizeUserUpdates(updates = {}) {
  const sanitized = {};
  Object.entries(updates).forEach(([field, value]) => {
    if (shouldPreserveProtectedField(field, value)) {
      return;
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
  const normalizedEmail = normalizeEmail(emailValue) || normalizeEmail(user.emailLower);
  const emailLower = normalizedEmail;
  const now = new Date().toISOString();
  const createdAt = toIso(user.createdAt) || now;
  const updatedAt = toIso(user.updatedAt) || now;
  const lastLogin = toIso(user.lastLogin) || now;
  const statusUpdatedAt = user.statusUpdatedAt ? toIso(user.statusUpdatedAt) : (user.status ? now : null);
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

  const item = {
    ...buildItemKey(USER_PREFIX, user.userId),
    itemType: 'USER',
    userId: String(user.userId),
    userName: user.userName || 'User',
    userNameLower: user.userName ? String(user.userName).trim().toLowerCase() : null,
    email: emailValue,
    emailLower,
    authType,
    isGuest: Boolean(user.isGuest),
    gender: user.gender || 'other',
    country: user.country || null,
    status: user.status || null,
    statusUpdatedAt,
    bio: user.bio || null,
    interests: Array.isArray(user.interests) ? user.interests : [],
    birthDate,
    profileComplete: Boolean(user.profileComplete),
    avatarColor: user.avatarColor || '#128C7E',
    avatarLetter: user.avatarLetter || (user.userName ? user.userName.charAt(0).toUpperCase() : 'U'),
    ...buildProfileImageFields(user),
    pictureName: user.pictureName || null,
    passwordHash: user.passwordHash || null,
    emailVerified: Boolean(user.emailVerified),
    emailVerifiedAt,
    isActive: user.isActive !== false,
    xp: typeof user.xp === 'object' && user.xp !== null ? user.xp : {},
    lastDailyXpAwardedAt: toIso(user.lastDailyXpAwardedAt) || null,
    createdAt,
    updatedAt,
    lastLogin,
  };

  if (user.expiresAt) {
    const expiry = user.expiresAt instanceof Date ? Math.floor(user.expiresAt.getTime() / 1000) : Number(user.expiresAt);
    if (!Number.isNaN(expiry)) item[TTL_ATTRIBUTE] = expiry;
  }

  return item;
}

function buildFriendItem(userId, friendId, status = 'pending') {
  return {
    ...buildItemKey(FRIEND_PREFIX, userId, `${FRIEND_PREFIX}${friendId}`),
    itemType: 'FRIEND',
    userId,
    friendId,
    requestId: `${userId}|${friendId}`,
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    friendIndexKey: `FRIEND_BY_FRIEND#${friendId}`,
  };
}

function serializeFriendRequestForClient(request, currentUserId, senderUser = null, recipientUser = null) {
  if (!request) return null;

  const senderId = normalizeIdValue(request.userId || request.senderId || request.fromUserId || null);
  const recipientId = normalizeIdValue(request.friendId || request.recipientId || request.toUserId || null);
  const requestId = normalizeIdValue(request.requestId || `${senderId}|${recipientId}`);
  const isIncoming = !!currentUserId && String(currentUserId) === String(recipientId);

  const fromUserId = isIncoming ? senderId : recipientId;
  const fromUserName = (isIncoming
    ? (senderUser?.userName || senderUser?.name || senderId)
    : (recipientUser?.userName || recipientUser?.name || recipientId)) || fromUserId || 'Unknown user';

  return {
    requestId,
    fromUserId,
    fromUserName,
    userId: senderId,
    friendId: recipientId,
    recipientUserId: recipientId,
    status: request.status || 'pending',
    createdAt: request.createdAt || null,
  };
}

function serializeFriendForClient(user) {
  if (!user) return null;

  const userId = normalizeIdValue(user.userId || user.friendId || user.id || null);
  const displayName = user.userName || user.name || userId || 'User';
  return {
    userId,
    id: userId,
    friendId: userId,
    userName: displayName,
    avatarColor: user.avatarColor || '#128C7E',
    avatarLetter: user.avatarLetter || String(displayName).charAt(0).toUpperCase(),
    profileImageUrl: user.profileImageUrl || null,
    profileImagePath: user.profileImagePath || null,
    country: user.country || null,
    gender: user.gender || 'other',
    status: user.status || null,
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
  };
}

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
    const found = items.find((it) => String(it.userId) === String(userId));
    return normalizeDdbItem(found || null);
  }

  const key = TABLE_HAS_SORT_KEY ? buildUserPrimaryKey(userId) : { [TABLE_HASH_KEY]: userId };
  const result = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  return normalizeDdbItem(result.Item || null);
}

async function getUserByEmail(email) {
  const emailLower = normalizeEmail(email);
  if (!emailLower) return null;

  if (USE_DEV_STORE) {
    const items = loadDevStore();
    const found = items.find((it) => it.emailLower && String(it.emailLower) === emailLower);
    if (found) return normalizeDdbItem(found);
    return null;
  }

  try {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'EmailIndex',
      KeyConditionExpression: 'emailLower = :emailLower',
      ExpressionAttributeValues: {
        ':emailLower': emailLower,
      },
      Limit: 1,
    }));

    if (result.Items && result.Items.length) {
      return normalizeDdbItem(result.Items[0]);
    }
  } catch (err) {
    // Query may fail if the GSI is missing or misconfigured; fall through to scan fallback.
  }

  const scan = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'emailLower = :emailLower',
    ExpressionAttributeValues: { ':emailLower': emailLower },
    Limit: 1,
  }));

  if (scan.Items && scan.Items.length) {
    return normalizeDdbItem(scan.Items[0]);
  }

  // Legacy fallback: some records may not have emailLower populated.
  const legacyScan = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'attribute_not_exists(emailLower)',
    Limit: 50,
  }));

  if (legacyScan.Items && legacyScan.Items.length) {
    const legacyUser = legacyScan.Items.find((item) => {
      return item.email && String(item.email).trim().toLowerCase() === emailLower;
    });
    if (legacyUser) {
      return normalizeDdbItem(legacyUser);
    }
  }

  return null;
}

async function findUserByLookup(lookup) {
  if (!lookup || typeof lookup !== 'object') return null;

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
    scanFilters.push('emailLower = :emailLower');
    expressionValues[':emailLower'] = normalizeEmail(lookup.email);
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
    const existing = items.find((u) => String(u.userId) === String(userData.userId));

    if (userData.email) {
      const emailCollisionUser = items.find((u) => u.email && String(u.email).trim().toLowerCase() === normalizeEmail(userData.email));
      if (emailCollisionUser && emailCollisionUser.userId !== userData.userId) {
        throw new Error('EMAIL_CONFLICT');
      }
    }

    let user = existing ? { ...existing, ...userData } : { ...userData };

    if (!existing) {
      const emailValue = user.email ? String(user.email).trim() : null;
      const emailLower = normalizeEmail(emailValue);
      user = {
        ...user,
        authType: normalizeAuthType(user.authType) ?? (Boolean(user.isGuest) ? 'GUEST' : (user.passwordHash ? 'MAIL' : (emailLower ? 'MAIL' : 'LOCAL'))),
        isGuest: Boolean(user.isGuest),
        userName: user.userName || 'User',
        profileComplete: Boolean(user.profileComplete),
        isActive: user.isActive !== false,
        email: emailValue,
        emailLower,
        createdAt: toIso(user.createdAt) || new Date().toISOString(),
        lastLogin: toIso(user.lastLogin) || new Date().toISOString(),
      };
    }

    const item = buildUserItem(user);
    // remove SK for hash-only tables in dev store representation
    if (!TABLE_HAS_SORT_KEY) delete item.SK;

    // upsert into dev store
    const filtered = items.filter((u) => String(u.userId) !== String(item.userId));
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
    const emailLower = normalizeEmail(emailValue);
    const normalizedEmail = emailLower;
    user = {
      ...user,
      authType: normalizeAuthType(user.authType) ??
        (Boolean(user.isGuest)
          ? 'GUEST'
          : user.passwordHash
            ? 'MAIL'
            : normalizedEmail
              ? 'MAIL'
              : 'LOCAL'),
      isGuest: Boolean(user.isGuest),
      userName: user.userName || 'User',
      profileComplete: Boolean(user.profileComplete),
      isActive: user.isActive !== false,
      email: emailValue,
      emailLower,
      createdAt: toIso(user.createdAt) || new Date().toISOString(),
      lastLogin: toIso(user.lastLogin) || new Date().toISOString(),
    };
  }

  const item = buildUserItem(user);
  if (!TABLE_HAS_SORT_KEY) {
    delete item.SK;
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
    const existingById = items.find((u) => String(u.userId) === String(userData.userId));
    if (existingById) throw new Error('USER_EXISTS');
    if (userData.email) {
      const existingByEmail = items.find((u) => u.email && String(u.email).trim().toLowerCase() === normalizeEmail(userData.email));
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
      const existingByEmail = items.find((u) => u.emailLower === normalizedEmail && String(u.userId) !== String(userId));
      if (existingByEmail) throw new Error('EMAIL_CONFLICT');
    }

    const merged = { ...current, ...safeUpdates, updatedAt: new Date().toISOString() };
    if (safeUpdates.email) {
      const emailValue = String(safeUpdates.email).trim();
      const normalizedEmail = normalizeEmail(emailValue);
      merged.email = emailValue;
      merged.emailLower = normalizedEmail;
    }

    const item = buildUserItem(merged);
    if (!TABLE_HAS_SORT_KEY) delete item.SK;
    const filtered = items.filter((u) => String(u.userId) !== String(userId));
    filtered.push(item);
    saveDevStore(filtered);
    return normalizeDdbItem(item);
  }

  if (safeUpdates.email) {
    const normalizedEmail = normalizeEmail(safeUpdates.email);
    const existingByEmail = await getUserByEmail(normalizedEmail);
    if (existingByEmail && existingByEmail.userId !== userId) {
      throw new Error('EMAIL_CONFLICT');
    }
  }

  const merged = { ...current, ...safeUpdates, updatedAt: new Date().toISOString() };
  if (safeUpdates.email) {
    const emailValue = String(safeUpdates.email).trim();
    const normalizedEmail = normalizeEmail(emailValue);
    merged.email = emailValue;
    merged.emailLower = normalizedEmail;
  }
  const item = buildUserItem(merged);
  if (!TABLE_HAS_SORT_KEY) {
    delete item.SK;
  }
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

async function deleteUserById(userId) {
  if (!userId) return null;
  return ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: buildItemKey(USER_PREFIX, userId) }));
}

async function searchUsers(query, limit = 25) {
  const queryLower = String(query || '').trim().toLowerCase();
  if (!queryLower) return [];
  const expressionValues = {
    ':userType': 'USER',
    ':query': queryLower,
  };
  const filter = 'itemType = :userType AND (contains(userNameLower, :query) OR contains(userName, :query) OR contains(userId, :query) OR contains(emailLower, :query))';

  if (USE_DEV_STORE) {
    const items = loadDevStore();
    const found = items.filter((it) => {
      const name = String(it.userName || '').toLowerCase();
      const email = String(it.email || '').toLowerCase();
      const id = String(it.userId || '').toLowerCase();
      return name.includes(queryLower) || email.includes(queryLower) || id.includes(queryLower);
    }).slice(0, limit).map(normalizeDdbItem);
    return found;
  }

  const result = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: filter,
    ExpressionAttributeValues: expressionValues,
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    Limit: limit,
    ProjectionExpression: 'userId, userName, userNameLower, email, gender, country, #status, bio, interests, avatarColor, avatarLetter, profileImageUrl, profileImagePath, authType, isGuest, createdAt, lastLogin, xp, itemType',
  }));

  return (result.Items || []).map(normalizeDdbItem);
}

async function clearExpiredStatuses(cutoffIso) {
  const result = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'itemType = :userType AND attribute_exists(#status) AND #status <> :empty AND statusUpdatedAt < :cutoff',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':userType': 'USER',
      ':empty': '',
      ':cutoff': cutoffIso,
    },
    ProjectionExpression: 'PK, SK',
  }));

  if (!result.Items || !result.Items.length) return 0;

  const deletePromises = result.Items.map((item) =>
    ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: item.PK, SK: item.SK },
      UpdateExpression: 'REMOVE #status, #statusUpdatedAt',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#statusUpdatedAt': 'statusUpdatedAt',
      },
    }))
  );

  await Promise.all(deletePromises);
  return result.Items.length;
}

function getDevStoreFriendItems() {
  if (!USE_DEV_STORE) return null;
  const items = loadDevStore();
  return Array.isArray(items) ? items.filter((item) => item?.itemType === 'FRIEND') : [];
}

function upsertDevStoreItem(item) {
  if (!USE_DEV_STORE || !item) return null;
  const items = loadDevStore();
  const key = item.userId ? `user:${String(item.userId)}` : (item.PK && item.SK ? `${String(item.PK)}:${String(item.SK)}` : null);
  if (!key) {
    items.push(item);
    saveDevStore(items);
    return item;
  }

  const filtered = items.filter((existing) => {
    if (item.userId && existing?.userId && String(existing.userId) === String(item.userId) && String(existing.itemType || '') === 'USER') {
      return false;
    }
    if (item.PK && item.SK && existing?.PK && existing?.SK && String(existing.PK) === String(item.PK) && String(existing.SK) === String(item.SK)) {
      return false;
    }
    return true;
  });

  filtered.push(item);
  saveDevStore(filtered);
  return item;
}

async function getFriendRequest(userId, friendId) {
  if (!userId || !friendId) return null;

  if (USE_DEV_STORE) {
    const items = getDevStoreFriendItems();
    const found = items.find((item) => String(item.userId) === String(userId) && String(item.friendId) === String(friendId));
    return found ? normalizeDdbItem(found) : null;
  }

  const result = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: buildItemKey(FRIEND_PREFIX, userId, `${FRIEND_PREFIX}${friendId}`) }));
  return result.Item || null;
}

async function getFriendBetween(userId, friendId) {
  let request = await getFriendRequest(userId, friendId);
  if (request) return request;
  return getFriendRequest(friendId, userId);
}

async function createFriendRequest(userId, friendId) {
  if (USE_DEV_STORE) {
    const items = getDevStoreFriendItems();
    const existing = items.find((item) => String(item.userId) === String(userId) && String(item.friendId) === String(friendId));
    if (existing) return existing;

    const item = buildFriendItem(userId, friendId, 'pending');
    if (!TABLE_HAS_SORT_KEY) delete item.SK;
    upsertDevStoreItem(item);
    return item;
  }

  const item = buildFriendItem(userId, friendId, 'pending');
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

async function updateFriendRequestStatus(userId, friendId, status) {
  const current = await getFriendRequest(userId, friendId);
  if (!current) return null;

  if (USE_DEV_STORE) {
    const items = getDevStoreFriendItems();
    const index = items.findIndex((item) => String(item.userId) === String(userId) && String(item.friendId) === String(friendId));
    if (index === -1) return null;

    const updated = { ...items[index], status, updatedAt: new Date().toISOString() };
    items[index] = updated;
    upsertDevStoreItem(updated);
    return normalizeDdbItem(updated);
  }

  const updated = { ...current, status, updatedAt: new Date().toISOString() };
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: updated }));
  return updated;
}

async function deleteFriendRequest(userId, friendId) {
  if (USE_DEV_STORE) {
    const items = getDevStoreFriendItems();
    const filtered = items.filter((item) => !(String(item.userId) === String(userId) && String(item.friendId) === String(friendId)));
    saveDevStore(filtered);
    return filtered;
  }

  return ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: buildItemKey(FRIEND_PREFIX, userId, `${FRIEND_PREFIX}${friendId}`) }));
}

async function getFriendRequestByRequestId(requestId) {
  if (!requestId) return null;
  const normalizedRequestId = String(requestId)
    .trim()
    .replace(/^"+|"+$/g, '')
    .replace(/^'+|'+$/g, '');

  if (USE_DEV_STORE) {
    const items = getDevStoreFriendItems();
    return items.find((item) => String(item.requestId) === normalizedRequestId) || null;
  }

  const result = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'itemType = :friendType AND requestId = :requestId',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':friendType': 'FRIEND',
      ':requestId': normalizedRequestId,
    },
    Limit: 1,
    ProjectionExpression: 'PK, SK, userId, friendId, #status, createdAt, updatedAt, requestId, friendIndexKey',
  }));
  return result.Items && result.Items.length ? result.Items[0] : null;
}

async function deleteFriendRelationship(userId, friendId) {
  if (USE_DEV_STORE) {
    const items = getDevStoreFriendItems();
    const filtered = items.filter((item) => !(
      (String(item.userId) === String(userId) && String(item.friendId) === String(friendId)) ||
      (String(item.userId) === String(friendId) && String(item.friendId) === String(userId))
    ));
    saveDevStore(filtered);
    return items.length - filtered.length;
  }

  const primary = getFriendRequest(userId, friendId);
  const reverse = getFriendRequest(friendId, userId);
  const requests = await Promise.all([primary, reverse]);
  const deleteOps = requests.filter(Boolean).map((request) =>
    ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: request.PK, SK: request.SK } }))
  );
  await Promise.all(deleteOps);
  return deleteOps.length;
}

async function queryFriendRequestsBySender(userId) {
  if (!userId) return [];

  if (USE_DEV_STORE) {
    const items = getDevStoreFriendItems();
    return items.filter((item) => String(item.userId) === String(userId) && String(item.status || '').toLowerCase() === 'pending');
  }

  await loadTableSchema();

  const hashKeyName = TABLE_HASH_KEY;
  const keyNameAlias = '#hashKey';
  const queryParams = {
    TableName: TABLE_NAME,
    KeyConditionExpression: `${keyNameAlias} = :pk`,
    ExpressionAttributeNames: {
      [keyNameAlias]: hashKeyName,
      '#status': 'status',
    },
    FilterExpression: '#status = :pending',
    ExpressionAttributeValues: {
      ':pk': `${FRIEND_PREFIX}${userId}`,
      ':pending': 'pending',
    },
  };

  try {
    const result = await ddb.send(new QueryCommand(queryParams));
    return result.Items || [];
  } catch (err) {
    const scanResult = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'itemType = :friendType AND userId = :userId AND #status = :pending',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':friendType': 'FRIEND',
        ':userId': userId,
        ':pending': 'pending',
      },
    }));
    return scanResult.Items || [];
  }
}

async function queryFriendRequestsByRecipient(userId) {
  if (!userId) return [];

  if (USE_DEV_STORE) {
    const items = getDevStoreFriendItems();
    return items.filter((item) => String(item.friendId) === String(userId) && String(item.status || '').toLowerCase() === 'pending');
  }

  const executeQuery = async () => ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'FriendByFriendIdIndex',
    KeyConditionExpression: 'friendIndexKey = :friendIndexKey',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    FilterExpression: '#status = :pending',
    ExpressionAttributeValues: {
      ':friendIndexKey': `FRIEND_BY_FRIEND#${userId}`,
      ':pending': 'pending',
    },
  }));

  try {
    const result = await executeQuery();
    return result.Items || [];
  } catch (err) {
    if (String(err.message).includes('does not have the specified index') || String(err.message).includes('Query condition missed key schema element')) {
      const scanResult = await ddb.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'friendIndexKey = :friendIndexKey AND #status = :pending',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':friendIndexKey': `FRIEND_BY_FRIEND#${userId}`,
          ':pending': 'pending',
        },
      }));
      return scanResult.Items || [];
    }
    throw err;
  }
}

async function listFriendsForUser(userId) {
  if (!userId) return [];

  if (USE_DEV_STORE) {
    const items = getDevStoreFriendItems();
    const friendIds = [];
    for (const item of items) {
      if (String(item.status || '').toLowerCase() !== 'accepted') continue;
      if (String(item.userId) === String(userId)) friendIds.push(String(item.friendId));
      if (String(item.friendId) === String(userId)) friendIds.push(String(item.userId));
    }
    return [...new Set(friendIds)];
  }

  await loadTableSchema();

  const hashKeyName = TABLE_HASH_KEY;
  const keyNameAlias = '#hashKey';
  let outgoing;
  try {
    outgoing = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: `${keyNameAlias} = :pk`,
      ExpressionAttributeNames: {
        [keyNameAlias]: hashKeyName,
        '#status': 'status',
      },
      FilterExpression: '#status = :accepted',
      ExpressionAttributeValues: {
        ':pk': `${FRIEND_PREFIX}${userId}`,
        ':accepted': 'accepted',
      },
    }));
  } catch (err) {
    const fallback = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'itemType = :friendType AND userId = :userId AND #status = :accepted',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':friendType': 'FRIEND',
        ':userId': userId,
        ':accepted': 'accepted',
      },
    }));
    outgoing = fallback;
  }

  let incoming;
  try {
    incoming = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'FriendByFriendIdIndex',
      KeyConditionExpression: 'friendIndexKey = :friendIndexKey',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      FilterExpression: '#status = :accepted',
      ExpressionAttributeValues: {
        ':friendIndexKey': `FRIEND_BY_FRIEND#${userId}`,
        ':accepted': 'accepted',
      },
    }));
  } catch (err) {
    const fallback = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'friendIndexKey = :friendIndexKey AND #status = :accepted',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':friendIndexKey': `FRIEND_BY_FRIEND#${userId}`,
        ':accepted': 'accepted',
      },
    }));
    incoming = fallback;
  }

  const outgoingIds = (outgoing.Items || []).map((item) => item.friendId);
  const incomingIds = (incoming.Items || []).map((item) => item.userId);
  return [...new Set([...outgoingIds, ...incomingIds])];
}

async function countFriendsForUser(userId) {
  const friendIds = await listFriendsForUser(userId);
  return friendIds.length;
}

async function getUsersByIds(userIds) {
  if (!Array.isArray(userIds) || !userIds.length) {
    return [];
  }

  if (USE_DEV_STORE) {
    const items = loadDevStore();
    const found = items.filter((it) => userIds.includes(String(it.userId))).map(normalizeDdbItem);
    return found;
  }

  const keys = userIds.map((id) => buildItemKey(USER_PREFIX, id));
  const result = await ddb.send(new BatchGetCommand({
    RequestItems: {
      [TABLE_NAME]: {
        Keys: keys,
      },
    },
  }));
  return result.Responses && result.Responses[TABLE_NAME] ? (result.Responses[TABLE_NAME].map(normalizeDdbItem)) : [];
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

async function deleteFriendRelationsForUser(userId) {
  if (!userId) return 0;
  const outgoing = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `${FRIEND_PREFIX}${userId}` },
    ProjectionExpression: 'PK, SK',
  }));
  const incoming = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'FriendByFriendIdIndex',
    KeyConditionExpression: 'friendIndexKey = :friendIndexKey',
    ExpressionAttributeValues: { ':friendIndexKey': `FRIEND_BY_FRIEND#${userId}` },
    ProjectionExpression: 'PK, SK',
  }));
  const items = [...(outgoing.Items || []), ...(incoming.Items || [])];
  const deleteOps = items.map((item) => ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: item.PK, SK: item.SK } })));
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

module.exports = {
  isDbConnected,
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
  getFriendRequest,
  getFriendRequestByRequestId,
  getFriendBetween,
  createFriendRequest,
  serializeFriendRequestForClient,
  serializeFriendForClient,
  updateFriendRequestStatus,
  deleteFriendRequest,
  deleteFriendRelationship,
  queryFriendRequestsBySender,
  queryFriendRequestsByRecipient,
  listFriendsForUser,
  countFriendsForUser,
  getUsersByIds,
  getActiveBlock,
  putBlockedUser,
  deleteBlock,
  getReportsForUser,
  getReport,
  createReport,
  deleteFriendRelationsForUser,
  deleteBlocksForUser,
  deleteReportsForUserAndReporter,
  getUserStats,
  normalizeProfileImageReference,
  buildProfileImageFields,
};
