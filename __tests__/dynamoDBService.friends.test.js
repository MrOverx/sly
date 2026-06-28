const fs = require('fs');
const path = require('path');

describe('friend persistence in the local dev store', () => {
  const storePath = path.resolve(__dirname, '..', 'dev_dynamo_users.json');

  beforeEach(() => {
    jest.resetModules();
    process.env.USE_DEV_STORE = 'true';
    delete process.env.DYNAMODB_ENDPOINT;
    fs.writeFileSync(storePath, '[]', 'utf8');
  });

  afterEach(() => {
    delete process.env.USE_DEV_STORE;
    delete process.env.DYNAMODB_ENDPOINT;
    fs.writeFileSync(storePath, '[]', 'utf8');
  });

  it('persists pending requests and accepted friendships locally', async () => {
    const service = require('../utils/dynamoDBService');

    await service.createUser({
      userId: 'u1',
      userName: 'Alice',
      email: 'alice@example.com',
      authType: 'MAIL',
      isGuest: false,
      profileComplete: true,
    });

    await service.createUser({
      userId: 'u2',
      userName: 'Bob',
      email: 'bob@example.com',
      authType: 'MAIL',
      isGuest: false,
      profileComplete: true,
    });

    const request = await service.createFriendRequest('u1', 'u2');
    expect(request.status).toBe('pending');
    expect(request.requestId).toBe('u1|u2');

    const incoming = await service.queryFriendRequestsByRecipient('u2');
    expect(incoming).toHaveLength(1);
    expect(incoming[0].userId).toBe('u1');

    const accepted = await service.updateFriendRequestStatus('u1', 'u2', 'accepted');
    expect(accepted.status).toBe('accepted');

    const alice = await service.getUserById('u1');
    const bob = await service.getUserById('u2');
    expect(alice.userId).toBe('u1');
    expect(bob.userId).toBe('u2');

    const friendsForU1 = await service.listFriendsForUser('u1');
    const friendsForU2 = await service.listFriendsForUser('u2');

    expect(friendsForU1).toEqual(['u2']);
    expect(friendsForU2).toEqual(['u1']);
  });
});
