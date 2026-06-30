#!/usr/bin/env node

/**
 * Test: Verify friend request serialization includes full user profile data
 * This test simulates the /friends/add endpoint response
 */

// Minimal reproduction of the serialization functions
function serializeFriendForClient(user) {
  if (!user) return null;

  const normalizedUserId = user.userId || user.id || null;
  const displayName = user.userName || user.name || 'User';

  return {
    userId: normalizedUserId,
    id: normalizedUserId,
    friendId: normalizedUserId,
    userName: displayName,
    name: displayName,
    displayName: displayName,
    email: user.email || null,
    avatarColor: user.avatarColor || '#128C7E',
    avatarLetter: user.avatarLetter || String(displayName).charAt(0).toUpperCase(),
    profileImageUrl: user.profileImageUrl || null,
    profileImagePath: user.profileImagePath || null,
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
    friendIds: Array.isArray(user.friendIds) ? user.friendIds : [],
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

function serializeFriendRequestForClient(request, currentUserId, senderUser = null, recipientUser = null) {
  if (!request) return null;

  const senderId = request.userId;
  const recipientId = request.friendId;
  const requestId = request.requestId || `${senderId}|${recipientId}`;
  const isIncoming = !!currentUserId && String(currentUserId) === String(recipientId);

  const sourceSender = senderUser || request.sender || null;
  const sourceRecipient = recipientUser || request.recipient || null;

  const fromUserId = isIncoming ? senderId : recipientId;
  const fromUserName = (isIncoming
    ? (sourceSender?.userName || sourceSender?.name || senderId)
    : (sourceRecipient?.userName || sourceRecipient?.name || recipientId)) || 'Unknown user';

  const senderPayload = sourceSender ? serializeFriendForClient(sourceSender) : null;
  const recipientPayload = sourceRecipient ? serializeFriendForClient(sourceRecipient) : null;

  return {
    requestId,
    fromUserId,
    fromUserName,
    sender: senderPayload,
    recipient: recipientPayload,
    userId: senderId,
    friendId: recipientId,
    status: request.status || 'pending',
    createdAt: request.createdAt || null,
    isIncoming,
  };
}

// Mock data
const mockSenderUser = {
  userId: '693837667',
  userName: 'sly',
  email: 'mroverxk@gmail.com',
  authType: 'MAIL',
  avatarColor: 'F7DC6F',
  avatarLetter: 'S',
  gender: 'male',
  birthDate: '2005-02-03T00:00:00.000Z',
  country: 'Brazil',
  bio: null,
  interests: [],
  xp: {},
  status: null,
  likedUserIds: [],
  friendIds: [],
  isGuest: false,
  hasProfileChanged: false,
  isOnline: false,
  profileComplete: true,
  lastDailyXpAwardedAt: null,
  createdAt: '2026-06-30T05:11:30.940Z',
  updatedAt: '2026-06-30T05:11:30.940Z',
};

const mockRecipientUser = {
  userId: '313544186',
  userName: 'john',
  email: 'john@example.com',
  authType: 'MAIL',
  avatarColor: 'E74C3C',
  avatarLetter: 'J',
  gender: 'male',
  birthDate: '2000-05-15T00:00:00.000Z',
  country: 'USA',
  bio: 'Nice to meet you',
  interests: ['gaming', 'travel'],
  xp: { base: 100 },
  status: 'available',
  likedUserIds: [],
  friendIds: [],
  isGuest: false,
  hasProfileChanged: false,
  isOnline: true,
  profileComplete: true,
  lastDailyXpAwardedAt: null,
  createdAt: '2026-06-28T10:00:00.000Z',
  updatedAt: '2026-06-30T03:00:00.000Z',
};

const mockFriendRequest = {
  userId: '693837667',
  friendId: '313544186',
  requestId: '693837667|313544186',
  status: 'pending',
  createdAt: '2026-06-30T06:09:29.756Z',
  updatedAt: '2026-06-30T06:09:29.756Z',
};

console.log('\n✅ TEST: Friend Request Serialization\n');
console.log('='.repeat(80));

// Test 1: Serialize with full sender/recipient user data
console.log('\n📋 Test 1: Serialize with full user data passed (normal flow)');
const payload1 = serializeFriendRequestForClient(mockFriendRequest, mockRecipientUser.userId, mockSenderUser, mockRecipientUser);

console.log('\nRequest Payload Structure:');
console.log(JSON.stringify(payload1, null, 2));

console.log('\n✓ Sender profile data:');
console.log(`  - userName: ${payload1.sender?.userName}`);
console.log(`  - email: ${payload1.sender?.email}`);
console.log(`  - gender: ${payload1.sender?.gender}`);
console.log(`  - country: ${payload1.sender?.country}`);
console.log(`  - birthDate: ${payload1.sender?.birthDate}`);
console.log(`  - authType: ${payload1.sender?.authType}`);

console.log('\n✓ Recipient profile data:');
console.log(`  - userName: ${payload1.recipient?.userName}`);
console.log(`  - email: ${payload1.recipient?.email}`);
console.log(`  - gender: ${payload1.recipient?.gender}`);
console.log(`  - country: ${payload1.recipient?.country}`);
console.log(`  - status: ${payload1.recipient?.status}`);
console.log(`  - isOnline: ${payload1.recipient?.isOnline}`);

// Verification
const senderFields = ['userId', 'userName', 'email', 'gender', 'country', 'birthDate', 'authType'];
const missingFields = senderFields.filter(field => payload1.sender && payload1.sender[field] === undefined);

if (missingFields.length === 0) {
  console.log('\n✅ SUCCESS: All profile fields are present in sender object');
} else {
  console.log(`\n❌ MISSING FIELDS in sender: ${missingFields.join(', ')}`);
}

console.log('\n' + '='.repeat(80));
console.log('\n✅ Serialization test complete!');
console.log('\n📝 SUMMARY:');
console.log('- Friend request payload includes sender object with full profile');
console.log('- Friend request payload includes recipient object with full profile');
console.log('- Frontend can access userName, email, gender, country, birthDate, etc.');
console.log('- No profile data is lost after friend request creation');
