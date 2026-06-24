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

  it('should reject inline image data and local file paths for profile image storage', () => {
    const dataUriImage = 'data:image/png;base64,AAAA';
    const localPathImage = '/tmp/avatar.png';

    const dataUriItem = buildUserItem({
      userId: 'test-user-data',
      userName: 'Test User',
      profileImageUrl: dataUriImage,
    });

    const localPathItem = buildUserItem({
      userId: 'test-user-local',
      userName: 'Test User',
      profileImagePath: localPathImage,
    });

    expect(dataUriItem.profileImageUrl).toBeNull();
    expect(dataUriItem.profileImagePath).toBeNull();
    expect(localPathItem.profileImageUrl).toBeNull();
    expect(localPathItem.profileImagePath).toBeNull();
  });

  it('should preserve remote profile image URLs for DynamoDB metadata', () => {
    const imageUrl = 'https://example.com/uploads/profile.png';
    const item = buildUserItem({
      userId: 'test-user-remote',
      userName: 'Test User',
      profileImageUrl: imageUrl,
    });

    expect(item.profileImageUrl).toBe(imageUrl);
    expect(item.profileImagePath).toBeNull();
  });
});
