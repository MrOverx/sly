const fs = require('fs');
const path = require('path');

const devStorePath = path.resolve(__dirname, '..', 'dev_dynamo_users.json');

function resetEnv() {
  delete process.env.USE_DEV_STORE;
  delete process.env.DYNAMODB_ENDPOINT;
  delete process.env.AWS_ENDPOINT;
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;
  delete process.env.AWS_DEFAULT_PROFILE;
  delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  delete process.env.AWS_WEB_IDENTITY_TOKEN_FILE;
  delete process.env.AWS_ROLE_ARN;
}

describe('DynamoDB service dev-store fallback', () => {
  beforeEach(() => {
    resetEnv();
    jest.resetModules();
    fs.writeFileSync(devStorePath, '[]', 'utf8');
  });

  afterEach(() => {
    resetEnv();
    jest.resetModules();
    fs.writeFileSync(devStorePath, '[]', 'utf8');
  });

  it('creates a user in the local dev store when AWS credentials are unavailable', async () => {
    const { createUser } = require('../utils/dynamoDBService');

    const createdUser = await createUser({
      userId: 'fallback-test-user',
      userName: 'Fallback User',
      email: 'fallback@example.com',
      authType: 'MAIL',
      isGuest: false,
      profileComplete: true,
    });

    expect(createdUser.userId).toBe('fallback-test-user');

    const persistedItems = JSON.parse(fs.readFileSync(devStorePath, 'utf8'));
    expect(persistedItems.some((item) => item.userId === 'fallback-test-user')).toBe(true);
  });
});
