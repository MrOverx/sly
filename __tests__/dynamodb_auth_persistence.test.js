const fs = require('fs');
const path = require('path');

function loadDdbService() {
  jest.resetModules();
  process.env.USE_DEV_STORE = 'true';
  delete process.env.DYNAMODB_ENDPOINT;
  const modulePath = path.resolve(__dirname, '..', 'utils', 'dynamoDBService.js');
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

describe('dynamoDBService auth persistence', () => {
  const devStorePath = path.resolve(__dirname, '..', 'dev_dynamo_users.json');

  beforeEach(() => {
    fs.writeFileSync(devStorePath, '[]', 'utf8');
  });

  afterEach(() => {
    fs.writeFileSync(devStorePath, '[]', 'utf8');
  });

  it('preserves password hash and email when an update tries to clear them', async () => {
    const ddbService = loadDdbService();

    const created = await ddbService.createUser({
      userId: 'user-123',
      email: 'demo@example.com',
      passwordHash: 'hashed-password',
      userName: 'Demo User',
    });

    expect(created.passwordHash).toBe('hashed-password');
    expect(created.email).toBe('demo@example.com');

    const updated = await ddbService.updateUserById('user-123', {
      profileImageUrl: null,
      passwordHash: null,
      email: '',
      userName: 'Updated Name',
    });

    expect(updated.userId).toBe('user-123');
    expect(updated.email).toBe('demo@example.com');
    expect(updated.passwordHash).toBe('hashed-password');
    expect(updated.userName).toBe('Updated Name');
  });
});
