const { buildUserItem } = require('../utils/dynamoDBService');

describe('DynamoDB user item profile image normalization', () => {
  it('should nullify oversized profileImageUrl values when building a user item', () => {
    const oversizedUrl = 'http://' + 'a'.repeat(20001);
    const item = buildUserItem({
      userId: 'test-user',
      userName: 'Test User',
      profileImageUrl: oversizedUrl,
    });

    expect(item.profileImageUrl).toBeNull();
    expect(item.profileImagePath).toBeNull();
  });

  it('should nullify oversized inline profileImagePath values when building a user item', () => {
    const dataUriPrefix = 'data:image/png;base64,';
    const oversizedInline = dataUriPrefix + 'A'.repeat(120 * 1024 + 1);
    const item = buildUserItem({
      userId: 'test-user',
      userName: 'Test User',
      profileImagePath: oversizedInline,
    });

    expect(item.profileImageUrl).toBeNull();
    expect(item.profileImagePath).toBeNull();
  });

  it('should collapse duplicate profileImageUrl and profileImagePath into profileImageUrl only', () => {
    const imageUrl = 'https://example.com/avatar.png';
    const item = buildUserItem({
      userId: 'test-user',
      userName: 'Test User',
      profileImageUrl: imageUrl,
      profileImagePath: imageUrl,
    });

    expect(item.profileImageUrl).toBe(imageUrl);
    expect(item.profileImagePath).toBeNull();
  });
});
