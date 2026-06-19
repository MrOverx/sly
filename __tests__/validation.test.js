const { validateProfileUpdate } = require('../middleware/validation');
const httpMocks = require('node-mocks-http');

function runValidation(body, params = { userId: 'test-user' }) {
  const req = httpMocks.createRequest({ method: 'POST', url: '/user/test-user/update', params, body });
  const res = httpMocks.createResponse();
  let nextCalled = false;
  const next = () => { nextCalled = true; };

  validateProfileUpdate(req, res, next);
  return { req, res, nextCalled };
}

describe('validateProfileUpdate', () => {
  it('should allow birthDate when present and not throw', () => {
    const result = runValidation({ birthDate: '1990-01-01T00:00:00Z' });
    expect(result.nextCalled).toBe(true);
    expect(result.res.statusCode).toBe(200);
    expect(result.req.body.birthDate).toBe('1990-01-01T00:00:00Z');
  });

  it('should reject invalid body types', () => {
    const req = httpMocks.createRequest({ method: 'POST', url: '/user/test-user/update', params: { userId: 'test-user' }, body: [] });
    const res = httpMocks.createResponse();
    let nextCalled = false;
    validateProfileUpdate(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res._getData()).toContain('Invalid profile data');
  });

  it('should reject profileImageUrl that exceeds the maximum string length', () => {
    const oversizedUrl = 'http://' + 'a'.repeat(20001);
    const result = runValidation({ profileImageUrl: oversizedUrl });
    expect(result.nextCalled).toBe(false);
    expect(result.res.statusCode).toBe(400);
    expect(result.res._getData()).toContain('profileImageUrl cannot exceed 20000 characters');
  });

  it('should reject inline profileImageUrl data URIs larger than the allowed inline limit', () => {
    const dataUriPrefix = 'data:image/png;base64,';
    const oversizedInline = dataUriPrefix + 'A'.repeat(120 * 1024 + 1);
    const result = runValidation({ profileImageUrl: oversizedInline });
    expect(result.nextCalled).toBe(false);
    expect(result.res.statusCode).toBe(400);
    expect(result.res._getData()).toContain('Inline profile image payload exceeds maximum allowed size');
  });

  it('should reject inline profileImagePath data URIs larger than the allowed inline limit', () => {
    const dataUriPrefix = 'data:image/jpeg;base64,';
    const oversizedInline = dataUriPrefix + 'A'.repeat(120 * 1024 + 1);
    const result = runValidation({ profileImagePath: oversizedInline });
    expect(result.nextCalled).toBe(false);
    expect(result.res.statusCode).toBe(400);
    expect(result.res._getData()).toContain('Inline profile image payload exceeds maximum allowed size');
  });
});
