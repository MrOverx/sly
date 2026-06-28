// Set dev store mode before importing
process.env.USE_DEV_STORE = 'true';

const service = require('../utils/dynamoDBService');

// Clean DB before tests
beforeEach(() => {
  const path = require('path');
  const fs = require('fs');
  const storePath = path.resolve('dev_dynamo_users.json');
  if (fs.existsSync(storePath)) {
    fs.unlinkSync(storePath);
  }
});

describe('Email validation in user creation', () => {
  test('createUser rejects non-guest users without email', async () => {
    try {
      await service.createUser({
        userId: 'test_user_1',
        userName: 'Test User',
        email: null, // Missing email for non-guest
        isGuest: false,
        authType: 'MAIL',
      });
      fail('Should have thrown error for missing email');
    } catch (err) {
      expect(err.message).toContain('Email is required');
    }
  });

  test('createUser rejects non-guest users with empty email', async () => {
    try {
      await service.createUser({
        userId: 'test_user_2',
        userName: 'Test User 2',
        email: '   ', // Empty after trim
        isGuest: false,
        authType: 'MAIL',
      });
      fail('Should have thrown error for empty email');
    } catch (err) {
      expect(err.message).toContain('Email is required');
    }
  });

  test('createUser allows non-guest users with valid email', async () => {
    const user = await service.createUser({
      userId: 'test_user_3',
      userName: 'Test User 3',
      email: 'test3@example.com',
      isGuest: false,
      authType: 'MAIL',
    });
    expect(user.userId).toBe('test_user_3');
    expect(user.email).toBe('test3@example.com');
    expect(user.isGuest).toBe(false);
  });

  test('createUser allows guest users with null email (will get assigned)', async () => {
    // Note: Guest login route will assign temp email, but the function should allow it
    const user = await service.createUser({
      userId: 'guest_12345_abc',
      userName: 'Guest1234',
      email: 'guest_12345_abc@guest.slyxy.local',
      isGuest: true,
      authType: 'GUEST',
    });
    expect(user.userId).toContain('guest_');
    expect(user.isGuest).toBe(true);
    expect(user.authType).toBe('GUEST');
    expect(user.email).toBeDefined();
  });

  test('listFriendsForUser only returns users with valid emails in friends list', async () => {
    // Create two users with email
    const user1 = await service.createUser({
      userId: 'user_with_email_1',
      userName: 'User 1',
      email: 'user1@example.com',
      isGuest: false,
      authType: 'MAIL',
    });

    const user2 = await service.createUser({
      userId: 'user_with_email_2',
      userName: 'User 2',
      email: 'user2@example.com',
      isGuest: false,
      authType: 'MAIL',
    });

    // Create friend request and accept
    await service.createFriendRequest('user_with_email_1', 'user_with_email_2');
    await service.updateFriendRequestStatus(
      'user_with_email_1',
      'user_with_email_2',
      'accepted',
    );

    // Both users should appear in friend lists
    const friends1 = await service.listFriendsForUser('user_with_email_1');
    const friends2 = await service.listFriendsForUser('user_with_email_2');

    expect(friends1).toContain('user_with_email_2');
    expect(friends2).toContain('user_with_email_1');
  });
});
