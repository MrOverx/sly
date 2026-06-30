describe('friend request persistence contract', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.USE_DEV_STORE = 'true';
    process.env.DYNAMODB_TABLE = 'oververseDB';
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
});
