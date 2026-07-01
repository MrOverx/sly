const fs = require('fs');
const path = require('path');

describe('friend request persistence contract', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.USE_DEV_STORE = 'true';
    process.env.DYNAMODB_TABLE = 'oververseDB';
    fs.rmSync(path.resolve(__dirname, '..', 'dev_dynamo_users.json'), { force: true });
  });

  afterEach(() => {
    delete process.env.USE_DEV_STORE;
    delete process.env.DYNAMODB_TABLE;
  });

  test('stores friend requests without embedded user snapshots', async () => {
    const svc = require('../utils/dynamoDBService');

    const item = await svc.createFriendRequest('u1', 'u2');

    expect(item.userId).toBe('u1');
    expect(item.friendId).toBe('u2');
    expect(item.sender).toBeUndefined();
    expect(item.recipient).toBeUndefined();
  });

  test('still serializes friend request payloads from supplied user profiles', async () => {
    const svc = require('../utils/dynamoDBService');

    const item = await svc.createFriendRequest('u1', 'u2');

    const payload = svc.serializeFriendRequestForClient(
      item,
      'u2',
      { userId: 'u1', userName: 'Alice' },
      { userId: 'u2', userName: 'Bob' }
    );

    expect(payload.fromUserName).toBe('Alice');
    expect(payload.sender?.userName).toBe('Alice');
    expect(payload.recipient?.userName).toBe('Bob');
  });

  test('uses recipientId as the canonical request target', async () => {
    const svc = require('../utils/dynamoDBService');

    const item = await svc.createFriendRequest('u1', 'u2');
    const payload = svc.serializeFriendRequestForClient(item, 'u2');

    expect(item.recipientId).toBe('u2');
    expect(payload.recipientId).toBe('u2');
    expect(payload.friendId).toBe('u2');
    expect(payload.senderId).toBe('u1');
  });

  test('stores pending friend requests on the sender and recipient user records', async () => {
    const svc = require('../utils/dynamoDBService');

    await svc.createUser({ userId: 'u1', userName: 'Alice', email: 'alice@example.com', authType: 'MAIL', isGuest: false, profileComplete: true });
    await svc.createUser({ userId: 'u2', userName: 'Bob', email: 'bob@example.com', authType: 'MAIL', isGuest: false, profileComplete: true });

    const item = await svc.createFriendRequest('u1', 'u2');

    const sender = await svc.getUserById('u1');
    const recipient = await svc.getUserById('u2');

    expect(sender.friendRequests).toEqual(expect.arrayContaining([expect.objectContaining({ requestId: item.requestId, status: 'pending' })]));
    expect(recipient.friendRequests).toEqual(expect.arrayContaining([expect.objectContaining({ requestId: item.requestId, status: 'pending' })]));
  });

  test('preserves the full user payload shape and object-based friendRequests', async () => {
    const svc = require('../utils/dynamoDBService');

    const userPayload = {
      itemType: 'USER',
      userId: 'u1',
      userName: 'Alice',
      email: 'alice@example.com',
      authType: 'MAIL',
      isGuest: false,
      profileComplete: true,
      avatarColor: '#4A90E2',
      avatarLetter: 'A',
      profileImageUrl: 'https://example.com/alice.png',
      country: 'USA',
      gender: 'female',
      bio: 'Hello world',
      interests: ['travel', 'music'],
      xp: { base: 120, daily: 20 },
      likedUserIds: ['u3'],
      useColorProfile: true,
      hasProfileChanged: true,
      isOnline: true,
      lastDailyXpAwardedAt: '2026-06-30T08:00:00.000Z',
      friendRequests: {
        sent: [
          {
            requestId: 'req-u1-u2',
            toUserId: 'u2',
            status: 'pending',
            createdAt: '2026-07-01T10:00:00.000Z',
          },
        ],
        received: [],
      },
      friends: [],
      friendIds: [],
    };

    const created = await svc.createUser(userPayload);
    const persisted = await svc.getUserById('u1');

    expect(created.userName).toBe('Alice');
    expect(created.avatarColor).toBe('#4A90E2');
    expect(created.profileImageUrl).toBe('https://example.com/alice.png');
    expect(persisted.friendRequests).toEqual(userPayload.friendRequests);
    expect(persisted.friendIds).toEqual([]);
    expect(persisted.friends).toEqual([]);
    expect(persisted.hasProfileChanged).toBe(true);
    expect(persisted.isOnline).toBe(true);
  });
});
