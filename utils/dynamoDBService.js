const { DynamoDBClient, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
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

const client = new DynamoDBClient({ region: AWS_REGION });
const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
  unmarshallOptions: {
    convertEmptyValues: false,
  },
});

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

function buildItemKey(prefix, id, sk = METADATA_SK) {
  return { PK: `${prefix}${id}`, SK: sk };
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

function buildUserItem(user) {
  if (!user || !user.userId) {
    throw new Error('User item requires userId');
  }

  const emailLower = normalizeEmail(user.email);
  const now = new Date().toISOString();
  const createdAt = toIso(user.createdAt) || now;
  const updatedAt = toIso(user.updatedAt) || now;
  const lastLogin = toIso(user.lastLogin) || now;
  const statusUpdatedAt = user.statusUpdatedAt ? toIso(user.statusUpdatedAt) : (user.status ? now : null);
  const emailVerifiedAt = user.emailVerifiedAt ? toIso(user.emailVerifiedAt) : null;
  const birthDate = toIso(user.birthDate) || null;

  const item = {
    ...buildItemKey(USER_PREFIX, user.userId),
    itemType: 'USER',
    userId: String(user.userId),
    userName: user.userName || 'User',
    email: user.email || null,
    emailLower,
    authType: user.authType || 'LOCAL',
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
    profileImageUrl: user.profileImageUrl || user.profileImagePath || null,
    profileImagePath: user.profileImagePath || user.profileImageUrl || null,
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
  try {
    await describeTable();
    return true;
  } catch (err) {
    return false;
  }
}

async function getUserById(userId) {
  if (!userId) return null;
  const result = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: buildItemKey(USER_PREFIX, userId) }));
  return result.Item || null;
}

async function getUserByEmail(email) {
  const emailLower = normalizeEmail(email);
  if (!emailLower) return null;

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
    return result.Items && result.Items.length ? result.Items[0] : null;
  } catch (err) {
    // Fallback if GSI is not configured or query fails
    const scan = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'emailLower = :emailLower',
      ExpressionAttributeValues: { ':emailLower': emailLower },
      Limit: 1,
    }));
    return scan.Items && scan.Items.length ? scan.Items[0] : null;
  }
}

async function upsertUser(userData) {
  if (!userData || !userData.userId) {
    throw new Error('User data must include userId');
  }

  const existing = await getUserById(userData.userId);
  let user = existing ? { ...existing, ...userData } : { ...userData };

  if (!existing) {
    const emailLower = normalizeEmail(user.email);
    user = {
      ...user,
      authType: user.authType || 'LOCAL',
      isGuest: Boolean(user.isGuest),
      userName: user.userName || 'User',
      profileComplete: Boolean(user.profileComplete),
      isActive: user.isActive !== false,
      emailLower,
      createdAt: toIso(user.createdAt) || new Date().toISOString(),
      lastLogin: toIso(user.lastLogin) || new Date().toISOString(),
    };
  }

  const item = buildUserItem(user);
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

async function createUser(userData) {
  if (!userData || !userData.userId) {
    throw new Error('User data must include userId');
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
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

async function updateUserById(userId, updates) {
  const current = await getUserById(userId);
  if (!current) return null;
  const merged = { ...current, ...updates, updatedAt: new Date().toISOString() };
  if (updates.email) merged.emailLower = normalizeEmail(updates.email);
  const item = buildUserItem(merged);
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
    ':userPrefix': USER_PREFIX,
    ':query': queryLower,
  };
  const filter = 'begins_with(PK, :userPrefix) AND (contains(userName, :query) OR contains(userId, :query) OR contains(emailLower, :query))';

  const result = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: filter,
    ExpressionAttributeValues: expressionValues,
    Limit: limit,
    ProjectionExpression: 'userId, userName, email, gender, country, status, bio, interests, avatarColor, avatarLetter, profileImageUrl, profileImagePath, createdAt, lastLogin, xp, itemType',
  }));

  return result.Items || [];
}

async function clearExpiredStatuses(cutoffIso) {
  const result = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'itemType = :userType AND attribute_exists(status) AND status <> :empty AND statusUpdatedAt < :cutoff',
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
      UpdateExpression: 'REMOVE status, statusUpdatedAt',
    }))
  );

  await Promise.all(deletePromises);
  return result.Items.length;
}

async function getFriendRequest(userId, friendId) {
  if (!userId || !friendId) return null;
  const result = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: buildItemKey(FRIEND_PREFIX, userId, `${FRIEND_PREFIX}${friendId}`) }));
  return result.Item || null;
}

async function getFriendBetween(userId, friendId) {
  let request = await getFriendRequest(userId, friendId);
  if (request) return request;
  return ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: buildItemKey(FRIEND_PREFIX, friendId, `${FRIEND_PREFIX}${userId}`) })).then((res) => res.Item || null);
}

async function createFriendRequest(userId, friendId) {
  const item = buildFriendItem(userId, friendId, 'pending');
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

async function updateFriendRequestStatus(userId, friendId, status) {
  const current = await getFriendRequest(userId, friendId);
  if (!current) return null;
  const updated = { ...current, status, updatedAt: new Date().toISOString() };
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: updated }));
  return updated;
}

async function deleteFriendRequest(userId, friendId) {
  return ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: buildItemKey(FRIEND_PREFIX, userId, `${FRIEND_PREFIX}${friendId}`) }));
}

async function getFriendRequestByRequestId(requestId) {
  if (!requestId) return null;
  const result = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'itemType = :friendType AND requestId = :requestId',
    ExpressionAttributeValues: {
      ':friendType': 'FRIEND',
      ':requestId': requestId,
    },
    Limit: 1,
    ProjectionExpression: 'PK, SK, userId, friendId, status, createdAt, updatedAt, requestId, friendIndexKey',
  }));
  return result.Items && result.Items.length ? result.Items[0] : null;
}

async function deleteFriendRelationship(userId, friendId) {
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
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `${FRIEND_PREFIX}${userId}`,
    },
    FilterExpression: 'status = :pending',
    ExpressionAttributeValues: {
      ':pk': `${FRIEND_PREFIX}${userId}`,
      ':pending': 'pending',
    },
  }));
  return result.Items || [];
}

async function queryFriendRequestsByRecipient(userId) {
  if (!userId) return [];
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'FriendByFriendIdIndex',
    KeyConditionExpression: 'friendIndexKey = :friendIndexKey',
    FilterExpression: 'status = :pending',
    ExpressionAttributeValues: {
      ':friendIndexKey': `FRIEND_BY_FRIEND#${userId}`,
      ':pending': 'pending',
    },
  }));
  return result.Items || [];
}

async function listFriendsForUser(userId) {
  if (!userId) return [];
  const outgoing = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    FilterExpression: 'status = :accepted',
    ExpressionAttributeValues: {
      ':pk': `${FRIEND_PREFIX}${userId}`,
      ':accepted': 'accepted',
    },
  }));

  const incoming = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'FriendByFriendIdIndex',
    KeyConditionExpression: 'friendIndexKey = :friendIndexKey',
    FilterExpression: 'status = :accepted',
    ExpressionAttributeValues: {
      ':friendIndexKey': `FRIEND_BY_FRIEND#${userId}`,
      ':accepted': 'accepted',
    },
  }));

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

  const keys = userIds.map((id) => buildItemKey(USER_PREFIX, id));
  const result = await ddb.send(new BatchGetCommand({
    RequestItems: {
      [TABLE_NAME]: {
        Keys: keys,
      },
    },
  }));
  return result.Responses && result.Responses[TABLE_NAME] ? result.Responses[TABLE_NAME] : [];
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
  return result.Items || [];
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
  upsertUser,
  createUser,
  updateUserById,
  deleteUserById,
  searchUsers,
  clearExpiredStatuses,
  getFriendRequest,
  getFriendRequestByRequestId,
  getFriendBetween,
  createFriendRequest,
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
};
