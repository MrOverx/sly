const { upsertUser, isDevStoreEnabled } = require('../utils/dynamoDBService');

async function main() {
  const user = {
    userId: '483526642',
    authType: 'MAIL',
    avatarColor: 'F7DC6F',
    avatarLetter: 'S',
    bio: null,
    birthDate: '2005-02-03T00:00:00.000Z',
    country: 'India',
    createdAt: '2026-07-03T01:15:07.426Z',
    email: 'mroverxk@gmail.com',
    emailLower: 'mroverxk@gmail.com',
    emailVerified: false,
    emailVerifiedAt: null,
    friendIds: [],
    friendRequests: [],
    friends: [],
    gender: 'male',
    hasProfileChanged: false,
    interests: [],
    isActive: true,
    isFriend: false,
    isGuest: false,
    isOnline: false,
    itemType: 'USER',
    lastDailyXpAwardedAt: null,
    lastLogin: '2026-07-03T01:15:07.412Z',
    likedUserIds: [],
    passwordHash: '$2a$10$b1HXwyx12y6uMCwMrQYvYe9WTsOtylthUwaKfcm1/.KmwOXB48fV6',
    pendingFriendRequests: [],
    pictureName: null,
    profileComplete: true,
    profileImagePath: null,
    profileImageUrl: 'https://slyxy-buckets.s3.ap-south-1.amazonaws.com/user/483526642/profilepic/current.jpg',
    status: null,
    statusUpdatedAt: null,
    updatedAt: '2026-07-03T01:15:17.039Z',
    useColorProfile: true,
    userName: 'scy',
    userNameLower: 'scy',
    xp: {},
  };

  try {
    console.log('Dev store enabled:', isDevStoreEnabled());
    const res = await upsertUser(user);
    console.log('Upsert result:', res);
  } catch (err) {
    console.error('Error upserting user:', err && err.message || err);
    process.exit(1);
  }
}

main();
