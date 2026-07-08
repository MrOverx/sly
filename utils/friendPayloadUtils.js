function normalizeIdValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function buildFriendRequestPayload(request = {}) {
  const requestId = normalizeIdValue(request.requestId || request.id || '');
  const senderId = normalizeIdValue(request.senderId || request.userId || request.fromUserId || '');
  const receiverId = normalizeIdValue(request.receiverId || request.recipientId || request.targetUserId || request.toUserId || '');
  const targetUserId = receiverId || normalizeIdValue(request.targetUserId || '');
  const normalized = {
    requestId,
    id: requestId,
    status: request.status || 'pending',
    createdAt: request.createdAt || request.timestamp || null,
    senderId,
    receiverId,
    recipientId: receiverId,
    userId: senderId,
    targetUserId,
    requestType: request.requestType || 'FRIEND_REQUEST_OUTGOING',
    isRead: Boolean(request.isRead),
    isReadByReceiver: Boolean(request.isReadByReceiver),
    isIncoming: Boolean(request.isIncoming),
    isOutgoing: !Boolean(request.isIncoming),
    sender: request.sender || null,
    receiver: request.receiver || request.to || null,
    to: request.to || request.receiver || null,
  };

  if (!normalized.requestId && senderId && targetUserId) {
    normalized.requestId = `${senderId}|${targetUserId}`;
    normalized.id = normalized.requestId;
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
    avatarUrl: user.profileImageUrl || user.profileImagePath || null,
    avatar_url: user.profileImageUrl || user.profileImagePath || null,
    profileImagePath: user.profileImagePath || user.profileImageUrl || null,
    profile_image_path: user.profileImagePath || user.profileImageUrl || null,
    profileImageUrl: user.profileImageUrl || user.profileImagePath || null,
    profile_image_url: user.profileImageUrl || user.profileImagePath || null,
    displayImagePath: user.profileImagePath || user.profileImageUrl || null,
    display_image_path: user.profileImagePath || user.profileImageUrl || null,
    displayImageUrl: user.profileImageUrl || user.profileImagePath || null,
    display_image_url: user.profileImageUrl || user.profileImagePath || null,
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
          .filter((request) => String(request.status || '').toLowerCase() === 'pending')
          .map((request) => buildFriendRequestPayload(request))
      : [],
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
  };

  return profile;
}

module.exports = {
  buildFriendRequestPayload,
  buildCompleteUserProfile,
};
