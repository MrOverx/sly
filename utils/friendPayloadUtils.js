function normalizeIdValue(value) {
  if (value === undefined || value === null) return '';
  try {
    return String(value).trim();
  } catch (e) {
    return '';
  }
}

const crypto = require('crypto');

function normalizeProfileImageReference(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const lowered = trimmed.toLowerCase();
    if (['null', 'undefined', 'none', 'nil', 'nan', '(null)', 'nullvalue'].includes(lowered)) {
      return null;
    }
    return trimmed;
  }
  return value;
}

function resolveProfileImageReference(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const candidates = [
    profile.profileImageUrl,
    profile.profile_image_url,
    profile.avatarUrl,
    profile.avatar_url,
    profile.profileImagePath,
    profile.profile_image_path,
    profile.displayImageUrl,
    profile.display_image_url,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeProfileImageReference(candidate);
    if (normalized !== null) {
      return normalized;
    }
  }

  return null;
}

function normalizeFriendRequestStatus(rawStatus) {
  const normalized = String(rawStatus ?? '').trim().toLowerCase();
  if (!normalized) return 'pending';
  if (['accepted', 'approved', 'accept', 'confirmed'].includes(normalized)) {
    return 'accepted';
  }
  if (['rejected', 'denied', 'declined', 'reject'].includes(normalized)) {
    return 'rejected';
  }
  if (['cancelled', 'canceled'].includes(normalized)) {
    return 'cancelled';
  }
  return normalized;
}

function buildFriendRequestPayload(request = {}) {
  const requestId = normalizeIdValue(request.requestId || request.id || '');
  const senderId = normalizeIdValue(
    request.senderId ||
      request.userId ||
      request.fromUserId ||
      (request.sender && (request.sender.userId || request.sender.id)) ||
      '',
  );
  const receiverId = normalizeIdValue(
    request.receiverId ||
      request.recipientId ||
      request.targetUserId ||
      request.toUserId ||
      (request.receiver && (request.receiver.userId || request.receiver.id)) ||
      '',
  );
  const targetUserId = receiverId || normalizeIdValue(request.targetUserId || '');
  const senderProfile = request.sender && typeof request.sender === 'object' ? request.sender : null;
  const receiverProfile = request.receiver && typeof request.receiver === 'object'
    ? request.receiver
    : (request.to && typeof request.to === 'object' ? request.to : null);
  const senderProfileImageUrl = resolveProfileImageReference(senderProfile);
  const receiverProfileImageUrl = resolveProfileImageReference(receiverProfile);
  const explicitRequestType = normalizeIdValue(
    request.requestType || request.RequestType || request.type || '',
  );
  const inferredRequestType = explicitRequestType ||
      (request.isIncoming === true ? 'FRIEND_REQUEST_INCOMING' : '') ||
      (request.isOutgoing === true ? 'FRIEND_REQUEST_OUTGOING' : '');

  const normalized = {
    requestId,
    status: normalizeFriendRequestStatus(request.status),
    createdAt: request.createdAt || request.timestamp || null,
    requestType: inferredRequestType !== '' ? inferredRequestType : 'FRIEND_REQUEST_OUTGOING',
    isRead: Boolean(request.isRead),
    isIncoming: Boolean(request.isIncoming),
    sender: senderProfile
      ? (function () {
          const sp = { ...senderProfile };
          sp.userId = sp.userId || sp.id || senderId || null;
          sp.id = sp.id || sp.userId || senderId || null;
          sp.userName = sp.userName || sp.user_name || sp.displayName || sp.name || '';
          sp.profileImageUrl = senderProfileImageUrl || sp.profileImageUrl || sp.profile_image_url || sp.avatarUrl || sp.avatar_url || sp.profileImagePath || sp.profile_image_path || null;
          return sp;
        })()
      : (senderId ? { userId: senderId, id: senderId, userName: '', profileImageUrl: null } : null),
    receiver: receiverProfile
      ? (function () {
          const rp = { ...receiverProfile };
          rp.userId = rp.userId || rp.id || receiverId || null;
          rp.id = rp.id || rp.userId || receiverId || null;
          rp.userName = rp.userName || rp.user_name || rp.displayName || rp.name || '';
          rp.profileImageUrl = receiverProfileImageUrl || rp.profileImageUrl || rp.profile_image_url || rp.avatarUrl || rp.avatar_url || rp.profileImagePath || rp.profile_image_path || null;
          return rp;
        })()
      : (receiverId ? { userId: receiverId, id: receiverId, userName: '', profileImageUrl: null } : null),
  };

  // Avoid composing requestId from sender|receiver (privacy/ambiguity).
  // Prefer any provided requestId; if missing, generate a stable, opaque id.
  if (!normalized.requestId) {
    const ts = normalized.createdAt ? new Date(normalized.createdAt).getTime() : Date.now();
    const rand = crypto.randomBytes(6).toString('hex');
    normalized.requestId = `req_${ts}_${rand}`;
  }

  return normalized;
}

function buildCompleteUserProfile(user) {
  if (!user) return null;

  const profile = {
    itemType: 'USER',
    userId: user.userId || user.id || user._id || null,
    id: user.userId || user.id || user._id || null,
    user_id: user.userId || user.id || user._id || null,
    userName: user.userName || user.name || user.displayName || 'User',
    name: user.userName || user.name || user.displayName || 'User',
    displayName: user.userName || user.name || user.displayName || 'User',
    email: user.email || null,
    avatarColor: user.avatarColor || '#128C7E',
    avatarLetter: user.avatarLetter || null,
    avatarUrl: resolveProfileImageReference(user),
    avatar_url: resolveProfileImageReference(user),
    profileImagePath: resolveProfileImageReference(user),
    profile_image_path: resolveProfileImageReference(user),
    profileImageUrl: resolveProfileImageReference(user),
    profile_image_url: resolveProfileImageReference(user),
    displayImagePath: resolveProfileImageReference(user),
    display_image_path: resolveProfileImageReference(user),
    displayImageUrl: resolveProfileImageReference(user),
    display_image_url: resolveProfileImageReference(user),
    useColorProfile: user.useColorProfile !== undefined ? Boolean(user.useColorProfile) : true,
    gender: user.gender || 'other',
    birthDate: user.birthDate || null,
    country: user.country || null,
    status: user.status || null,
    bio: user.bio || null,
    interests: Array.isArray(user.interests) ? user.interests : [],
    xp: typeof user.xp === 'object' && user.xp !== null ? user.xp : {},
    likedUserIds: Array.isArray(user.likedUserIds) ? user.likedUserIds : [],
    authType: user.authType || 'LOCAL',
    isGuest: user.isGuest === true,
    hasProfileChanged: user.hasProfileChanged === true,
    isOnline: user.isOnline === true,
    isFriend: user.isFriend === true,
    friends: Array.isArray(user.friends)
      ? user.friends.map((friend) => ({
          friendId: friend.friendId || friend.userId || friend.id || friend._id || null,
          addedAt: friend.addedAt || null,
          userId: friend.userId || friend.friendId || friend.id || friend._id || null,
        }))
      : [],
    friendRequests: Array.isArray(user.friendRequests)
      ? user.friendRequests.map((request) => buildFriendRequestPayload(request))
      : [],
    pendingFriendRequests: Array.isArray(user.friendRequests)
      ? user.friendRequests
          .filter((request) => normalizeFriendRequestStatus(request.status) === 'pending')
          .map((request) => buildFriendRequestPayload(request))
      : [],
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
  };

  return profile;
}

module.exports = {
  normalizeFriendRequestStatus,
  normalizeProfileImageReference,
  resolveProfileImageReference,
  buildFriendRequestPayload,
  buildCompleteUserProfile,
};
