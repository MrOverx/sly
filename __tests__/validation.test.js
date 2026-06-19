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
});
