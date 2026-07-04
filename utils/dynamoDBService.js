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
const { Logger } = require('./logger');

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
  const isTestProcess = typeof process.env.JEST_WORKER_ID !== 'undefined' || process.env.NODE_ENV === 'test';
  if (process.env.NODE_ENV === 'production' && !isTestProcess) {
    if (process.env.USE_DEV_STORE === 'true') {
      console.error('[dynamoDBService] USE_DEV_STORE=true is not allowed in production. Production must use DynamoDB.');
    }
    return false;
  }

  if (process.env.USE_DEV_STORE === 'true') {
    console.warn('[dynamoDBService] Local dev fallback store enabled explicitly via USE_DEV_STORE=true');
    return true;
  }

  if (process.env.USE_DEV_STORE === 'false') {
    console.info('[dynamoDBService] Local dev fallback store disabled explicitly via USE_DEV_STORE=false');
    return false;
  }

  // Default behavior: do not use local JSON fallback unless explicitly requested
  // or when running automated tests.
  return isTestProcess;
}

// Development fallback: simple JSON-backed store when running locally without DynamoDB.
// It is enabled automatically when no AWS credentials are present so local signup flows still persist data.
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
  if (field === 'email' || field === 'passwordHash' || field === 'userId') {
    if (value === null) return true;
    if (typeof value === 'string' && value.trim().length === 0) return true;
  }
  return false;
}

function isDisallowedUserField(field) {
  return field === 'emailLower' || field === 'userNameLower' || field === 'normalizedEmail' || field === 'normalizedUserName';
}

function sanitizeUserUpdates(updates = {}) {
  const sanitized = {};
  Object.entries(updates).forEach(([field, value]) => {
    if (isDisallowedUserField(field) || shouldPreserveProtectedField(field, value)) {
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
  const normalizedEmail = normalizeEmail(emailValue);
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
    email: emailValue,
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
    useColorProfile: user.useColorProfile !== undefined ? Boolean(user.useColorProfile) : true,
    hasProfileChanged: Boolean(user.hasProfileChanged),
    isFriend: Boolean(user.isFriend),
    isOnline: Boolean(user.isOnline),
    ...buildProfileImageFields(user),
    pictureName: user.pictureName || null,
    passwordHash: user.passwordHash || null,
    emailVerified: Boolean(user.emailVerified),
    emailVerifiedAt,
    isActive: user.isActive !== false,
    xp: typeof user.xp === 'object' && user.xp !== null ? user.xp : {},
    likedUserIds: Array.isArray(user.likedUserIds) ? user.likedUserIds : [],
    friendIds: Array.isArray(user.friendIds)
      ? user.friendIds
      : (Array.isArray(user.friends)
          ? user.friends
              .map((friend) => {
                if (friend && typeof friend === 'object') {
                  return friend.friendId || friend.userId || friend.id || null;
                }
                return friend;
              })
              .filter(Boolean)
          : []),
    friends: Array.isArray(user.friends) ? user.friends : [],
    friendRequests: normalizeFriendRequestsValue(user.friendRequests),
    pendingFriendRequests: normalizeFriendRequestsValue(user.pendingFriendRequests),
    lastDailyXpAwardedAt: toIso(user.lastDailyXpAwardedAt) || null,
    createdAt,
    updatedAt,
    lastLogin,
  };

  // Persist an internal normalized email attribute for efficient lookups and
  // indexing. This attribute is intentionally not exposed to clients via
  // serialization helpers.
  if (normalizedEmail) item.normalizedEmail = normalizedEmail;

  if (user.expiresAt) {
    const expiry = user.expiresAt instanceof Date ? Math.floor(user.expiresAt.getTime() / 1000) : Number(user.expiresAt);
    if (!Number.isNaN(expiry)) item[TTL_ATTRIBUTE] = expiry;
  }

  return item;
}

function buildUserSnapshot(user) {
  if (!user || !user.userId) return null;

  return {
    userId: String(user.userId),
    userName: user.userName || user.name || user.displayName || String(user.userId),
    email: user.email || null,
    avatarColor: user.avatarColor || '#128C7E',
    avatarLetter: user.avatarLetter || (user.userName ? String(user.userName).charAt(0).toUpperCase() : 'U'),
    profileImageUrl: user.profileImageUrl || null,
    profileImagePath: user.profileImagePath || null,
    gender: user.gender || 'other',
    birthDate: toIso(user.birthDate) || null,
    country: user.country || null,
    status: user.status || null,
    bio: user.bio || null,
    interests: Array.isArray(user.interests) ? user.interests : [],
    xp: typeof user.xp === 'object' && user.xp !== null ? user.xp : {},
    authType: user.authType || null,
    isGuest: Boolean(user.isGuest),
    hasProfileChanged: Boolean(user.hasProfileChanged),
    isOnline: Boolean(user.isOnline),
    lastDailyXpAwardedAt: toIso(user.lastDailyXpAwardedAt) || null,
  };
}

function buildFriendItem(userId, friendId, status = 'pending', data = {}) {
  const normalizedUserId = normalizeIdValue(userId);
  const normalizedRecipientId = normalizeIdValue(friendId);

  const item = {
    ...buildItemKey(FRIEND_PREFIX, normalizedUserId, `${FRIEND_PREFIX}${normalizedRecipientId}`),
    itemType: 'FRIEND',
    userId: normalizedUserId,
    senderId: normalizedUserId,
    friendId: normalizedRecipientId,
    recipientId: normalizedRecipientId,
    requestId: `${normalizedUserId}|${normalizedRecipientId}`,
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    friendIndexKey: `FRIEND_BY_FRIEND#${normalizedRecipientId}`,
  };

  if (data.sender) {
    item.sender = data.sender;
  }
  if (data.recipient) {
    item.recipient = data.recipient;
  }

  return item;
}

function normalizeFriendRequestItem(item) {
  if (!item || item.itemType !== 'FRIEND') return item;

  const normalized = { ...item };
  if (!normalized.recipientId && normalized.friendId) {
    normalized.recipientId = normalized.friendId;
  }
  if (!normalized.senderId && normalized.userId) {
    normalized.senderId = normalized.userId;
  }

  return normalized;
}

function normalizeFriendRequestEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.filter(Boolean).map((entry) => {
    if (!entry || typeof entry !== 'object') {
      return { requestId: String(entry), status: 'pending' };
    }
    return entry;
  });
}

function isObjectFriendRequests(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && (Array.isArray(value.sent) || Array.isArray(value.received));
}

function normalizeFriendRequestsValue(value) {
  if (Array.isArray(value)) {
    return normalizeFriendRequestEntries(value);
  }

  if (isObjectFriendRequests(value)) {
    return {
      sent: normalizeFriendRequestEntries(value.sent),
      received: normalizeFriendRequestEntries(value.received),
    };
  }

  return [];
}

function buildFriendRequestReference(requestItem, status = 'pending') {
  const normalizedRequest = normalizeFriendRequestItem(requestItem || {});
  const senderId = normalizeIdValue(normalizedRequest.userId || normalizedRequest.senderId || normalizedRequest.fromUserId || null);
  const recipientId = normalizeIdValue(normalizedRequest.recipientId || normalizedRequest.friendId || normalizedRequest.toUserId || normalizedRequest.recipientUserId || null);
  const requestId = normalizeIdValue(normalizedRequest.requestId || `${senderId}|${recipientId}`);

  return {
    requestId,
    userId: senderId,
    senderId,
    recipientId,
    friendId: recipientId,
    status: String(status || normalizedRequest.status || 'pending').toLowerCase(),
    createdAt: normalizedRequest.createdAt || new Date().toISOString(),
    updatedAt: normalizedRequest.updatedAt || new Date().toISOString(),
  };
}

function mergeFriendRequestReference(existingRequests = [], requestItem, status = 'pending', currentUserId = null) {
  const reference = buildFriendRequestReference(requestItem, status);
  const requestId = reference.requestId;

  if (isObjectFriendRequests(existingRequests)) {
    const bucket = normalizeIdValue(currentUserId) === normalizeIdValue(reference.userId || reference.senderId)
      ? 'sent'
      : normalizeIdValue(currentUserId) === normalizeIdValue(reference.recipientId || reference.friendId)
        ? 'received'
        : 'sent';
    const nextEntries = normalizeFriendRequestEntries(existingRequests[bucket]);
    const existingIndex = nextEntries.findIndex((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const candidateId = normalizeIdValue(entry.requestId || `${entry.userId || entry.senderId || ''}|${entry.friendId || entry.recipientId || ''}`);
      return candidateId === requestId;
    });

    if (existingIndex >= 0) {
      nextEntries[existingIndex] = {
        ...nextEntries[existingIndex],
        ...reference,
        requestId,
        userId: reference.userId,
        senderId: reference.senderId,
        recipientId: reference.recipientId,
        friendId: reference.friendId,
      };
    } else {
      nextEntries.push(reference);
    }

    return {
      ...existingRequests,
      [bucket]: nextEntries,
    };
  }

  const nextRequests = Array.isArray(existingRequests) ? existingRequests.filter(Boolean) : [];
  const existingIndex = nextRequests.findIndex((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const candidateId = normalizeIdValue(entry.requestId || `${entry.userId || entry.senderId || ''}|${entry.friendId || entry.recipientId || ''}`);
    return candidateId === requestId;
  });

  if (existingIndex >= 0) {
    nextRequests[existingIndex] = {
      ...nextRequests[existingIndex],
      ...reference,
      requestId,
      userId: reference.userId,
      senderId: reference.senderId,
      recipientId: reference.recipientId,
      friendId: reference.friendId,
    };
    return nextRequests;
  }

  nextRequests.push(reference);
  return nextRequests;
}

async function persistFriendRequestOnUser(userId, requestItem, status = 'pending') {
  if (!userId || !requestItem) return null;

  const currentUser = await getUserById(userId);
  const nextRequests = mergeFriendRequestReference(currentUser?.friendRequests, requestItem, status, userId);

  if (!currentUser) {
    const snapshot = buildUserSnapshot(
      normalizeIdValue(userId) === normalizeIdValue(requestItem.userId || requestItem.senderId)
        ? requestItem.sender
        : requestItem.recipient
    );
    return upsertUser({
      userId,
      userName: snapshot?.userName || userId,
      email: snapshot?.email || null,
      authType: snapshot?.authType || 'LOCAL',
      isGuest: snapshot?.isGuest ?? true,
      profileComplete: false,
      friendRequests: nextRequests,
      pendingFriendRequests: nextRequests,
      avatarColor: snapshot?.avatarColor,
      avatarLetter: snapshot?.avatarLetter,
      profileImageUrl: snapshot?.profileImageUrl,
      profileImagePath: snapshot?.profileImagePath,
      gender: snapshot?.gender,
      country: snapshot?.country,
      status: snapshot?.status,
      bio: snapshot?.bio,
      interests: snapshot?.interests,
      xp: snapshot?.xp,
      hasProfileChanged: snapshot?.hasProfileChanged,
      isOnline: snapshot?.isOnline,
      lastDailyXpAwardedAt: snapshot?.lastDailyXpAwardedAt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  const updatedUser = await updateUserById(userId, {
    friendRequests: nextRequests,
    pendingFriendRequests: nextRequests,
    updatedAt: new Date().toISOString(),
  });

  return updatedUser;
}

function serializeFriendRequestForClient(request, currentUserId, senderUser = null, recipientUser = null) {
  if (!request) return null;

  const senderId = normalizeIdValue(request.userId || request.senderId || request.fromUserId || null);
  const recipientId = normalizeIdValue(request.recipientId || request.friendId || request.recipientUserId || request.toUserId || null);
  const requestId = normalizeIdValue(request.requestId || `${senderId}|${recipientId}`);
  const isIncoming = !!currentUserId && String(currentUserId) === String(recipientId);

  const sourceSender = senderUser || request.sender || null;
  const sourceRecipient = recipientUser || request.recipient || null;

  const fromUserId = isIncoming ? senderId : recipientId;
  const fromUserName = (isIncoming
    ? (sourceSender?.userName || sourceSender?.name || senderId)
    : (sourceRecipient?.userName || sourceRecipient?.name || recipientId)) || fromUserId || 'Unknown user';

  const fromUserAvatar = isIncoming
    ? sourceSender?.avatarColor || '#128C7E'
    : sourceRecipient?.avatarColor || '#128C7E';

  const fromUserImage = isIncoming
    ? sourceSender?.profileImageUrl || sourceSender?.profileImagePath || null
    : sourceRecipient?.profileImageUrl || sourceRecipient?.profileImagePath || null;

  const senderPayload = sourceSender
    ? serializeFriendForClient({ ...sourceSender, userId: senderId, id: senderId, friendId: senderId })
    : null;
  const recipientPayload = sourceRecipient
    ? serializeFriendForClient({ ...sourceRecipient, userId: recipientId, id: recipientId, friendId: recipientId })
    : null;

  return {
    requestId,
    fromUserId,
    fromUserName,
    fromUserAvatar,
    fromUserImage,
    profileImageUrl: fromUserImage,
    sender: senderPayload,
    recipient: recipientPayload,
    userId: senderId,
    senderId,
    recipientId,
    friendId: recipientId,
    recipientUserId: recipientId,
    status: request.status || 'pending',
    createdAt: request.createdAt || null,
    isIncoming,
    isOutgoing: !isIncoming,
    itemType: 'FRIEND',
    type: isIncoming ? 'friend_request' : 'friend_request_outgoing',
  };
}

function serializeFriendForClient(user) {
  if (!user) return null;

  const normalizedUserId = normalizeIdValue(user.userId || user.friendId || user.id || null);
  const displayName = user.userName || user.name || user.displayName || normalizedUserId || 'User';

  const profileImagePath = user.profileImagePath || user.profileImageUrl || null;
  const profileImageUrl = user.profileImageUrl || user.profileImagePath || null;

  return {
    userId: normalizedUserId,
    id: normalizedUserId,
    friendId: normalizedUserId,
    userName: displayName,
    name: displayName,
    displayName: displayName,
    email: user.email || null,
    passwordHash: user.passwordHash || null,
    avatarColor: user.avatarColor || '#128C7E',
    avatarLetter: user.avatarLetter || String(displayName).charAt(0).toUpperCase(),
    profileImageUrl,
    profile_image_url: profileImageUrl,
    profileImagePath,
    profile_image_path: profileImagePath,
    avatarUrl: profileImageUrl,
    avatar_url: profileImageUrl,
    displayImagePath: profileImagePath,
    display_image_path: profileImagePath,
    displayImageUrl: profileImageUrl,
    display_image_url: profileImageUrl,
    pictureName: user.pictureName || null,
    useColorProfile: user.useColorProfile !== undefined ? Boolean(user.useColorProfile) : true,
    gender: user.gender || 'other',
    birthDate: user.birthDate || null,
    country: user.country || null,
    status: user.status || null,
    bio: user.bio || null,
    interests: Array.isArray(user.interests) ? user.interests : [],
    xp: typeof user.xp === 'object' && user.xp !== null ? user.xp : {},
    likedUserIds: Array.isArray(user.likedUserIds) ? user.likedUserIds : [],
    authType: user.authType || null,
    isGuest: user.isGuest === true,
    hasProfileChanged: user.hasProfileChanged === true,
    isOnline: user.isOnline === true,
    profileComplete: user.profileComplete === true,
    lastDailyXpAwardedAt: user.lastDailyXpAwardedAt || null,
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

  // Legacy fallback: some records may not have normalizedEmail populated.
  // This scans items without normalizedEmail to support older user records.
  let lastEvaluatedKey = null;
  do {
    const legacyScan = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'attribute_not_exists(normalizedEmail)',
      ExclusiveStartKey: lastEvaluatedKey || undefined,
      ProjectionExpression: 'userId, email, emailLower, passwordHash',
    }));

    if (legacyScan.Items && legacyScan.Items.length) {
      const legacyUser = legacyScan.Items.find((item) =>
        item.email && String(item.email).trim().toLowerCase() === normalized,
      );
      if (legacyUser) {
        return normalizeDdbItem(legacyUser);
      }
    }

    lastEvaluatedKey = legacyScan.LastEvaluatedKey;
  } while (lastEvaluatedKey);

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
      const existingByEmail = items.find((u) => u.email && String(u.email).trim().toLowerCase() === normalizedEmail && String(u.userId) !== String(userId));
      if (existingByEmail) throw new Error('EMAIL_CONFLICT');
    }

    const merged = { ...current, ...safeUpdates, updatedAt: new Date().toISOString() };
    if (safeUpdates.email) {
      const emailValue = String(safeUpdates.email).trim();
      merged.email = emailValue;
    }

    const item = buildUserItem(merged);
    if (!TABLE_HAS_SORT_KEY) delete item.SK;
    const filtered = items.filter((u) => !(u.itemType === 'USER' && String(u.userId) === String(userId)));
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

  // Build a non-destructive UpdateCommand so we don't accidentally overwrite
  // the entire user item when only a few attributes need changing. This
  // preserves any attributes not present in `safeUpdates`.
  const key = buildUserPrimaryKey(userId);

  const exprNames = {};
  const exprValues = {};
  const setParts = [];

  // If email is being updated, also persist normalizedEmail for index lookups
  if (safeUpdates.email) {
    const emailValue = safeUpdates.email ? String(safeUpdates.email).trim() : null;
    exprNames['#email'] = 'email';
    exprValues[':email'] = emailValue;
    setParts.push('#email = :email');

    const normalizedEmail = normalizeEmail(emailValue);
    exprNames['#normalizedEmail'] = 'normalizedEmail';
    exprValues[':normalizedEmail'] = normalizedEmail;
    setParts.push('#normalizedEmail = :normalizedEmail');
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
  const isUserItem = String(item.itemType || '').toUpperCase() === 'USER';
  const key = isUserItem && item.userId ? `user:${String(item.userId)}` : (item.PK && item.SK ? `${String(item.PK)}:${String(item.SK)}` : null);
  if (!key) {
    items.push(item);
    saveDevStore(items);
    return item;
  }

  // Preserve user records: only replace USER items when the incoming item is also a USER.
  // For non-USER items (FRIEND, BLOCK, REPORT, etc.) match by PK/SK when available.
  const filtered = items.filter((existing) => {
    if (isUserItem && existing?.userId && String(existing.userId) === String(item.userId) && String(existing.itemType || '').toUpperCase() === 'USER') {
      return false;
    }

    if (!isUserItem && item.PK && item.SK && existing?.PK && existing?.SK && String(existing.PK) === String(item.PK) && String(existing.SK) === String(item.SK)) {
      return false;
    }

    if (!isUserItem && item.PK && !item.SK && existing?.PK && !existing?.SK && String(existing.PK) === String(item.PK) && String(existing.itemType || '').toUpperCase() === String(item.itemType || '').toUpperCase()) {
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
  if (!USE_DEV_STORE) await loadTableSchema();

  if (USE_DEV_STORE) {
    const items = getDevStoreFriendItems();
    const found = items.find((item) => String(item.userId) === String(userId) && String(item.friendId) === String(friendId));
    return found ? normalizeFriendRequestItem(normalizeDdbItem(found)) : null;
  }

  const result = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: buildItemKey(FRIEND_PREFIX, userId, `${FRIEND_PREFIX}${friendId}`) }));
  return result.Item ? normalizeFriendRequestItem(normalizeDdbItem(result.Item)) : null;
}

async function getFriendBetween(userId, friendId) {
  let request = await getFriendRequest(userId, friendId);
  if (request) return request;
  return getFriendRequest(friendId, userId);
}

async function createFriendRequest(userId, friendId, senderUser = null, recipientUser = null) {
  if (!USE_DEV_STORE) await loadTableSchema();

  const senderSnapshot = buildUserSnapshot(senderUser);
  const recipientSnapshot = buildUserSnapshot(recipientUser);

  if (USE_DEV_STORE) {
    const items = getDevStoreFriendItems();
    const existing = items.find((item) => String(item.userId) === String(userId) && String(item.friendId) === String(friendId));
    if (existing) {
      const normalizedExisting = normalizeFriendRequestItem(existing);
      const updatedExisting = {
        ...normalizedExisting,
        sender: senderSnapshot || normalizedExisting.sender,
        recipient: recipientSnapshot || normalizedExisting.recipient,
      };
      const existingIndex = items.findIndex((item) => String(item.userId) === String(userId) && String(item.friendId) === String(friendId));
      items[existingIndex] = updatedExisting;
      saveDevStore(items);
      await Promise.all([
        persistFriendRequestOnUser(userId, updatedExisting, 'pending'),
        persistFriendRequestOnUser(friendId, updatedExisting, 'pending'),
      ]);
      return updatedExisting;
    }

    const item = buildFriendItem(userId, friendId, 'pending', {
      sender: senderSnapshot,
      recipient: recipientSnapshot,
    });
    if (!TABLE_HAS_SORT_KEY) delete item.SK;
    upsertDevStoreItem(item);
    await Promise.all([
      persistFriendRequestOnUser(userId, item, 'pending'),
      persistFriendRequestOnUser(friendId, item, 'pending'),
    ]);
    return item;
  }

  const item = buildFriendItem(userId, friendId, 'pending', {
    sender: senderSnapshot,
    recipient: recipientSnapshot,
  });
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  await Promise.all([
    persistFriendRequestOnUser(userId, item, 'pending'),
    persistFriendRequestOnUser(friendId, item, 'pending'),
  ]);
  return item;
}

async function updateFriendRequestStatus(userId, friendId, status) {
  if (!USE_DEV_STORE) await loadTableSchema();
  const current = await getFriendRequest(userId, friendId);
  if (!current) return null;

  if (USE_DEV_STORE) {
    const items = getDevStoreFriendItems();
    const index = items.findIndex((item) => String(item.userId) === String(userId) && String(item.friendId) === String(friendId));
    if (index === -1) return null;

    const updated = normalizeFriendRequestItem({ ...items[index], status, updatedAt: new Date().toISOString() });
    items[index] = updated;
    upsertDevStoreItem(updated);
    await Promise.all([
      persistFriendRequestOnUser(userId, updated, status),
      persistFriendRequestOnUser(friendId, updated, status),
    ]);
    return updated;
  }

  const updated = normalizeFriendRequestItem({ ...current, status, updatedAt: new Date().toISOString() });
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: updated }));
  await Promise.all([
    persistFriendRequestOnUser(userId, updated, status),
    persistFriendRequestOnUser(friendId, updated, status),
  ]);
  return updated;
}

async function deleteFriendRequest(userId, friendId) {
  if (!USE_DEV_STORE) await loadTableSchema();
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

  if (!USE_DEV_STORE) await loadTableSchema();
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
    ProjectionExpression: 'PK, SK, userId, friendId, #status, createdAt, updatedAt, requestId, friendIndexKey, sender, recipient',
  }));
  return result.Items && result.Items.length ? normalizeFriendRequestItem(normalizeDdbItem(result.Items[0])) : null;
}

async function deleteFriendRelationship(userId, friendId) {
  if (!USE_DEV_STORE) await loadTableSchema();
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
    const found = items
      .filter((it) => it.itemType === 'USER' && userIds.includes(String(it.userId)))
      .map(normalizeDdbItem);
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

// Helper function to check friendship status between two users
async function getFriendshipStatus(userId, friendId) {
  if (!userId || !friendId) return null;

  // Check if they are already friends (accepted)
  const friendRecord = await getFriendRequest(userId, friendId);
  if (friendRecord && String(friendRecord.status || '').toLowerCase() === 'accepted') {
    return 'FRIEND';
  }

  // Check reverse direction
  const reverseFriendRecord = await getFriendRequest(friendId, userId);
  if (reverseFriendRecord && String(reverseFriendRecord.status || '').toLowerCase() === 'accepted') {
    return 'FRIEND';
  }

  // Check if pending request exists
  if (friendRecord && String(friendRecord.status || '').toLowerCase() === 'pending') {
    return 'PENDING';
  }
  if (reverseFriendRecord && String(reverseFriendRecord.status || '').toLowerCase() === 'pending') {
    return 'PENDING';
  }

  return null;
}

// Helper function to get pending request between two users (either direction)
async function getFriendRequestBetweenUsers(userId, friendId) {
  if (!userId || !friendId) return null;

  // Check userId -> friendId
  const request1 = await getFriendRequest(userId, friendId);
  if (request1 && String(request1.status || '').toLowerCase() === 'pending') {
    return request1;
  }

  // Check friendId -> userId
  const request2 = await getFriendRequest(friendId, userId);
  if (request2 && String(request2.status || '').toLowerCase() === 'pending') {
    return request2;
  }

  return null;
}

// Atomically accept a friend request and create bidirectional friend records.
// Uses DynamoDB TransactWrite to ensure request status update and friend puts succeed together.
async function acceptFriendRequestTransaction(requestItem) {
  if (!requestItem) return null;
  if (!USE_DEV_STORE) await loadTableSchema();
  const senderId = normalizeIdValue(requestItem.userId || requestItem.senderId || requestItem.fromUserId);
  const recipientId = normalizeIdValue(requestItem.friendId || requestItem.recipientId || requestItem.toUserId);
  if (!senderId || !recipientId) return null;

  const requestKey = buildItemKey(FRIEND_PREFIX, senderId, `${FRIEND_PREFIX}${recipientId}`);
  const friendItem1 = buildFriendItem(senderId, recipientId, 'accepted');
  const friendItem2 = buildFriendItem(recipientId, senderId, 'accepted');

  const transactItems = [];

  // Update the original friend request item to 'accepted' only if it is still 'pending'
  transactItems.push({
    Update: {
      TableName: TABLE_NAME,
      Key: requestKey,
      UpdateExpression: 'SET #status = :accepted, updatedAt = :now',
      ConditionExpression: '#status = :pending',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':accepted': 'accepted', ':pending': 'pending', ':now': new Date().toISOString() },
    }
  });

  // Put both friend records; allow put even if record already exists (idempotent)
  const acceptedFriendItem1 = buildFriendItem(senderId, recipientId, 'accepted', {
    sender: requestItem.sender || null,
    recipient: requestItem.recipient || null,
  });
  const acceptedFriendItem2 = buildFriendItem(recipientId, senderId, 'accepted', {
    sender: requestItem.recipient || null,
    recipient: requestItem.sender || null,
  });

  transactItems.push({ Put: { TableName: TABLE_NAME, Item: acceptedFriendItem1 } });
  transactItems.push({ Put: { TableName: TABLE_NAME, Item: acceptedFriendItem2 } });

  // Also update the user records to include friendIds (store only IDs, no snapshots)
  const senderUserKey = buildItemKey(USER_PREFIX, senderId);
  const recipientUserKey = buildItemKey(USER_PREFIX, recipientId);

  // Add recipientId to sender's friendIds if not present
  transactItems.push({
    Update: {
      TableName: TABLE_NAME,
      Key: senderUserKey,
      UpdateExpression: 'SET friendIds = list_append(if_not_exists(friendIds, :emptyList), :toAdd), updatedAt = :now',
      ConditionExpression: 'attribute_not_exists(friendIds) OR NOT contains(friendIds, :friendId)',
      ExpressionAttributeValues: {
        ':emptyList': [],
        ':toAdd': [recipientId],
        ':friendId': recipientId,
        ':now': new Date().toISOString(),
      },
    }
  });

  // Add senderId to recipient's friendIds if not present
  transactItems.push({
    Update: {
      TableName: TABLE_NAME,
      Key: recipientUserKey,
      UpdateExpression: 'SET friendIds = list_append(if_not_exists(friendIds, :emptyList), :toAdd), updatedAt = :now',
      ConditionExpression: 'attribute_not_exists(friendIds) OR NOT contains(friendIds, :friendId)',
      ExpressionAttributeValues: {
        ':emptyList': [],
        ':toAdd': [senderId],
        ':friendId': senderId,
        ':now': new Date().toISOString(),
      },
    }
  });

  // Add a persistent notification for the original sender so they can
  // view the "accepted" event from the database (used by notifications UI)
  try {
    const now = new Date().toISOString();
    const notificationForSender = {
      id: `friend_accept_${recipientId}_${now}`,
      type: 'friend_request_accepted',
      requestId: requestItem.requestId || `${senderId}|${recipientId}`,
      fromUserId: recipientId,
      toUserId: senderId,
      activity: `${recipientId} accepted your friend request`,
      createdAt: now,
    };

    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: senderUserKey,
        UpdateExpression: 'SET notifications = list_append(if_not_exists(notifications, :emptyList), :toAdd), updatedAt = :now',
        ExpressionAttributeValues: {
          ':emptyList': [],
          ':toAdd': [notificationForSender],
          ':now': now,
        },
      }
    });
  } catch (e) {
    // Best-effort: don't block the transaction if notification marshalling fails
    Logger.warn('acceptFriendRequestTransaction', 'Failed to prepare notification', e && e.message);
  }

  try {
    if (USE_DEV_STORE) {
      // Update local JSON store atomically in memory
      const items = loadDevStore();
      // Find the friend request item (PK/SK match)
      const reqIndex = items.findIndex((it) => it.itemType === 'FRIEND' && String(it.userId) === String(senderId) && String(it.friendId) === String(recipientId));
      if (reqIndex >= 0) {
        items[reqIndex].status = 'accepted';
        items[reqIndex].updatedAt = new Date().toISOString();
      } else {
        // Try reverse lookup
        const revIndex = items.findIndex((it) => it.itemType === 'FRIEND' && String(it.userId) === String(recipientId) && String(it.friendId) === String(senderId));
        if (revIndex >= 0) {
          items[revIndex].status = 'accepted';
          items[revIndex].updatedAt = new Date().toISOString();
        }
      }

      // Upsert accepted friend records for both directions into the loaded array
      const item1 = buildFriendItem(senderId, recipientId, 'accepted', {
        sender: requestItem.sender || null,
        recipient: requestItem.recipient || null,
      });
      const item2 = buildFriendItem(recipientId, senderId, 'accepted', {
        sender: requestItem.recipient || null,
        recipient: requestItem.sender || null,
      });

      function replaceOrPush(arr, itm) {
        const existingIndex = arr.findIndex((e) => (e.PK && e.SK && itm.PK && itm.SK && String(e.PK) === String(itm.PK) && String(e.SK) === String(itm.SK)) || (e.itemType === 'FRIEND' && e.userId && e.friendId && String(e.userId) === String(itm.userId) && String(e.friendId) === String(itm.friendId)));
        if (existingIndex >= 0) arr[existingIndex] = itm;
        else arr.push(itm);
      }

      replaceOrPush(items, item1);
      replaceOrPush(items, item2);

      // Update USER records in dev store to include friendIds (ID-only)
      function upsertFriendIdForUser(arr, targetUserId, newFriendId) {
        const userIndex = arr.findIndex((e) => e.itemType === 'USER' && (String(e.userId) === String(targetUserId) || (e.PK && e.PK.includes(targetUserId))));
        if (userIndex >= 0) {
          const user = arr[userIndex];
          const existingFriends = Array.isArray(user.friendIds) ? user.friendIds : [];
          if (!existingFriends.map(String).includes(String(newFriendId))) {
            user.friendIds = existingFriends.concat([newFriendId]);
            user.updatedAt = new Date().toISOString();
            arr[userIndex] = user;
          }
        } else {
          // If no user record found, create a lightweight USER placeholder with friendIds
          const userItem = buildUserItem({ userId: targetUserId, userName: targetUserId });
          userItem.friendIds = [newFriendId];
          userItem.updatedAt = new Date().toISOString();
          arr.push(userItem);
        }
      }

      upsertFriendIdForUser(items, senderId, recipientId);
      upsertFriendIdForUser(items, recipientId, senderId);

      // Mark the pending friend request as accepted in both user profile arrays.
      const acceptedRequest = buildFriendRequestReference({ ...requestItem, status: 'accepted', updatedAt: new Date().toISOString() }, 'accepted');
      const senderUser = items.find((e) => e.itemType === 'USER' && String(e.userId) === String(senderId));
      if (senderUser) {
        senderUser.friendRequests = mergeFriendRequestReference(Array.isArray(senderUser.friendRequests) ? senderUser.friendRequests : senderUser.friendRequests, acceptedRequest, 'accepted', senderUser.userId);
        senderUser.pendingFriendRequests = senderUser.friendRequests;
        senderUser.updatedAt = new Date().toISOString();
      }
      const recipientUser = items.find((e) => e.itemType === 'USER' && String(e.userId) === String(recipientId));
      if (recipientUser) {
        recipientUser.friendRequests = mergeFriendRequestReference(Array.isArray(recipientUser.friendRequests) ? recipientUser.friendRequests : recipientUser.friendRequests, acceptedRequest, 'accepted', recipientUser.userId);
        recipientUser.pendingFriendRequests = recipientUser.friendRequests;
        recipientUser.updatedAt = new Date().toISOString();
      }

      // Add notification to sender's user record in dev store so notifications
      // can be read from the DB-backed user record.
      try {
        const now = new Date().toISOString();
        const notif = {
          id: `friend_accept_${recipientId}_${now}`,
          type: 'friend_request_accepted',
          requestId: acceptedRequest.requestId,
          fromUserId: recipientId,
          toUserId: senderId,
          activity: `${recipientId} accepted your friend request`,
          createdAt: now,
        };

        if (senderUser) {
          senderUser.notifications = Array.isArray(senderUser.notifications) ? senderUser.notifications : [];
          senderUser.notifications.push(notif);
          senderUser.updatedAt = new Date().toISOString();
        }
      } catch (e) {
        Logger.warn('acceptFriendRequestTransaction/devstore', 'Failed to append notification', e && e.message);
      }

      // Persist the modified store once
      saveDevStore(items);
      const updated = Object.assign({}, requestItem, { status: 'accepted', updatedAt: new Date().toISOString() });
      await Promise.all([
        persistFriendRequestOnUser(senderId, updated, 'accepted'),
        persistFriendRequestOnUser(recipientId, updated, 'accepted'),
      ]);
      return updated;
    }

    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
    // Return an updated request-like object to the caller
    const updated = Object.assign({}, requestItem, { status: 'accepted', updatedAt: new Date().toISOString() });
    await Promise.all([
      persistFriendRequestOnUser(senderId, updated, 'accepted'),
      persistFriendRequestOnUser(recipientId, updated, 'accepted'),
    ]);
    return updated;
  } catch (err) {
    // If conditional check fails, attempt to read the current state and return it
    if (err && err.name === 'ConditionalCheckFailedException') {
      const current = await getFriendRequestBetweenUsers(senderId, recipientId);
      return current || null;
    }
    throw err;
  }
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
  // Internal helpers (not exported): normalizeProfileImageReference, buildProfileImageFields
  getFriendshipStatus,
  getFriendRequestBetweenUsers,
  acceptFriendRequestTransaction,
};
