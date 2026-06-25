const Module = require('module');

describe('s3Service profile image storage', () => {
  const originalLoad = Module._load;
  const s3ServicePath = require.resolve('../utils/s3Service');

  beforeEach(() => {
    process.env.AWS_S3_BUCKET = 'test-bucket';
    process.env.AWS_REGION = 'us-east-1';
    delete require.cache[s3ServicePath];
  });

  afterEach(() => {
    Module._load = originalLoad;
    delete require.cache[s3ServicePath];
    delete process.env.AWS_S3_BUCKET;
    delete process.env.AWS_REGION;
  });

  it('uses a stable object key for the current profile image of a user', () => {
    const { getS3ObjectKey } = require('../utils/s3Service');
    const firstKey = getS3ObjectKey('avatar.png', 'user-123');
    const secondKey = getS3ObjectKey('avatar.png', 'user-123');

    expect(firstKey).toBe(secondKey);
    expect(firstKey).toContain('profiles/user-123/profilepic/current');
  });

  it('builds a canonical public URL for browser access', () => {
    const { getPublicUrl } = require('../utils/s3Service');

    expect(getPublicUrl('profiles/user-123/profilepic/current.png')).toBe(
      'https://test-bucket.s3.amazonaws.com/profiles/user-123/profilepic/current.png',
    );
  });

  it('recognizes S3 URLs generated from the configured bucket', () => {
    const { isS3Url } = require('../utils/s3Service');

    expect(isS3Url('https://test-bucket.s3.us-east-1.amazonaws.com/profiles/user-123/profilepic/current.png')).toBe(true);
    expect(isS3Url('https://cdn.example.com/profiles/user-123/profilepic/current.png')).toBe(false);
  });

  it('loads without crashing when AWS SDK packages are unavailable', () => {
    Module._load = function(request, parent, isMain) {
      if (request === '@aws-sdk/client-s3' || request === '@aws-sdk/s3-request-presigner') {
        throw new Error('Cannot find module');
      }

      return originalLoad.apply(this, [request, parent, isMain]);
    };

    expect(() => require('../utils/s3Service')).not.toThrow();
  });
});
