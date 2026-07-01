const { validateProfileUpdate } = require('../middleware/validation');
const httpMocks = require('node-mocks-http');

function runValidation(body, params = { userId: 'user_12345' }) {
  const req = httpMocks.createRequest({ method: 'POST', url: '/user/user_12345/update', params, body });
  const res = httpMocks.createResponse();
  let nextCalled = false;
  const next = () => { nextCalled = true; };

  validateProfileUpdate(req, res, next);
  return { req, res, nextCalled };
}

describe('profile validation - new domain fields', () => {
  const sample = {
    userId: 'user_12345',
    userName: 'SlyxyStar',
    email: 'slyxystar@example.com',
    avatarLetter: 's',
    useColorProfile: true,
    likedUserIds: ['user_67890', 'user_54321'],
    friends: [{ friendId: 'user_67890', addedAt: '2026-06-15T12:30:00.000Z' }],
    xp: { base: 150, daily: 20, social: 45 },
    isOnline: true,
    isFriend: true,
    hasProfileChanged: true,
    lastDailyXpAwardedAt: '2026-06-30T09:00:00.000Z',
  };

  it('accepts and sanitizes a full domain profile payload', () => {
    const r = runValidation(sample);
    expect(r.nextCalled).toBe(true);
    expect(r.res.statusCode).toBe(200);
    expect(r.req.body.avatarLetter).toBe('S');
    expect(r.req.body.useColorProfile).toBe(true);
    expect(Array.isArray(r.req.body.likedUserIds)).toBe(true);
    expect(r.req.body.likedUserIds.length).toBe(2);
    expect(Array.isArray(r.req.body.friends)).toBe(true);
    expect(r.req.body.friends[0].friendId).toBe('user_67890');
    // friendRequests handling is disabled
    expect(r.req.body.xp).toEqual(sample.xp);
    expect(r.req.body.isOnline).toBe(true);
    expect(r.req.body.isFriend).toBe(true);
    expect(r.req.body.hasProfileChanged).toBe(true);
  });

  it('rejects invalid avatarLetter values', () => {
    const result = runValidation({ avatarLetter: 'AB' });
    expect(result.nextCalled).toBe(false);
    expect(result.res.statusCode).toBe(400);
    expect(result.res._getData()).toContain('avatarLetter must be a single ASCII letter');
  });

  it('rejects non-array likedUserIds', () => {
    const result = runValidation({ likedUserIds: 'not-an-array' });
    expect(result.nextCalled).toBe(false);
    expect(result.res.statusCode).toBe(400);
    expect(result.res._getData()).toContain('likedUserIds must be an array');
  });

  // friendRequests validation tests removed per feature toggle
});
