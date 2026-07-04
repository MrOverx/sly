const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.USE_DEV_STORE = 'true';

jest.resetModules();

const { mergeFriendRequestReference, removeFriendRequestReference, mergeFriendList } = require('../utils/dynamoDBService');

describe('friend request persistence helpers', () => {
  const devStorePath = path.resolve(__dirname, '..', 'dev_dynamo_users.json');

  beforeEach(() => {
    fs.writeFileSync(devStorePath, JSON.stringify([], null, 2), 'utf8');
  });

  afterEach(() => {
    fs.writeFileSync(devStorePath, JSON.stringify([], null, 2), 'utf8');
  });

  it('merges a new request into the correct bucket without overwriting existing ones', () => {
    const existing = {
      sent: [{ requestId: 'u1|u2', userId: 'u1', friendId: 'u2', status: 'pending' }],
      received: [{ requestId: 'u3|u1', userId: 'u3', friendId: 'u1', status: 'pending' }],
    };

    const next = mergeFriendRequestReference(existing, { userId: 'u1', friendId: 'u4', requestId: 'u1|u4' }, 'pending', 'u1');

    expect(next.sent).toHaveLength(2);
    expect(next.received).toHaveLength(1);
    expect(next.sent.find((entry) => entry.requestId === 'u1|u4')).toMatchObject({ status: 'pending', friendId: 'u4' });
  });

  it('removes a request from both buckets and keeps unrelated entries intact', () => {
    const existing = {
      sent: [{ requestId: 'u1|u2', userId: 'u1', friendId: 'u2', status: 'pending' }],
      received: [
        { requestId: 'u1|u2', userId: 'u1', friendId: 'u2', status: 'pending' },
        { requestId: 'u3|u1', userId: 'u3', friendId: 'u1', status: 'pending' },
      ],
    };

    const next = removeFriendRequestReference(existing, { userId: 'u1', friendId: 'u2', requestId: 'u1|u2' });

    expect(next.sent).toEqual([]);
    expect(next.received).toHaveLength(1);
    expect(next.received[0].requestId).toBe('u3|u1');
  });

  it('adds a friend once while preserving existing friend entries', () => {
    const next = mergeFriendList([{ friendId: 'u2', addedAt: '2024-01-01T00:00:00.000Z' }], 'u3');

    expect(next).toHaveLength(2);
    expect(next.some((entry) => entry.friendId === 'u3')).toBe(true);
    expect(next.find((entry) => entry.friendId === 'u2').addedAt).toBe('2024-01-01T00:00:00.000Z');
  });
});
