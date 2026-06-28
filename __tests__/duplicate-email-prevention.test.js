// Set dev store mode before importing
process.env.USE_DEV_STORE = 'true';

const {
  createUser,
  getUserByEmail,
  deleteUser,
} = require('../utils/dynamoDBService');

// Clean DB before tests
beforeEach(() => {
  const path = require('path');
  const fs = require('fs');
  const storePath = path.resolve('dev_dynamo_users.json');
  if (fs.existsSync(storePath)) {
    fs.unlinkSync(storePath);
  }
});

describe('Duplicate Email Prevention', () => {
  const testEmail = 'duplicate-test@example.com';

  it('should reject non-guest user creation without email', async () => {
    try {
      await createUser({
        userId: 'test-no-email-' + Date.now(),
        userName: 'NoEmailUser',
        isGuest: false,
        // Missing email field
      });
      expect(true).toBe(false); // Should have thrown
    } catch (error) {
      expect(error.message).toContain('Email is required');
    }
  });

  it('should allow non-guest user creation with email', async () => {
    const user = await createUser({
      userId: 'test-with-email-' + Date.now(),
      userName: 'WithEmailUser',
      email: testEmail,
      isGuest: false,
    });
    expect(user.email).toBe(testEmail);
  });

  it('should allow finding existing email', async () => {
    const userId = 'test-lookup-' + Date.now();
    const email = 'lookup-test-' + Date.now() + '@example.com';
    
    // Create user
    await createUser({
      userId: userId,
      userName: 'LookupUser',
      email: email,
      isGuest: false,
    });
    
    // Look it up
    const existingUser = await getUserByEmail(email);
    expect(existingUser).not.toBeNull();
    expect(existingUser.email).toBe(email);
  });

  it('should return null for non-existent email', async () => {
    const nonExistentEmail = 'nonexistent-' + Date.now() + '@example.com';
    const result = await getUserByEmail(nonExistentEmail);
    expect(result).toBeNull();
  });

  it('should allow guest users without email', async () => {
    const guestUser = await createUser({
      userId: 'test-guest-' + Date.now(),
      userName: 'GuestUser',
      isGuest: true,
      // No email provided - guests can be created without email
    });
    expect(guestUser.isGuest).toBe(true);
    // Guest users will get email assigned by guest login route if needed
  });
});
