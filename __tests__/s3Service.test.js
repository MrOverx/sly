const { getS3ObjectKey, isS3Url } = require('../utils/s3Service');

describe('s3Service profile image storage', () => {
  beforeEach(() => {
    process.env.AWS_S3_BUCKET = 'test-bucket';
    process.env.AWS_REGION = 'us-east-1';
  });

  afterEach(() => {
    delete process.env.AWS_S3_BUCKET;
    delete process.env.AWS_REGION;
  });

  it('uses a stable object key for the current profile image of a user', () => {
    const firstKey = getS3ObjectKey('avatar.png', 'user-123');
    const secondKey = getS3ObjectKey('avatar.png', 'user-123');

    expect(firstKey).toBe(secondKey);
    expect(firstKey).toContain('profiles/user-123/profilepic/current');
  });

  it('recognizes S3 URLs generated from the configured bucket', () => {
    expect(isS3Url('https://test-bucket.s3.us-east-1.amazonaws.com/profiles/user-123/profilepic/current.png')).toBe(true);
    expect(isS3Url('https://cdn.example.com/profiles/user-123/profilepic/current.png')).toBe(false);
  });
});
