const { Logger } = require('../utils/logger');

describe('Logger sanitization', () => {
  beforeEach(() => {
    Logger._rateLimitBuckets = new Map();
  });

  it('redacts sensitive values while preserving safe metadata', () => {
    const payload = {
      userId: 'user-123',
      password: 'super-secret',
      nested: {
        token: 'abc123',
        email: 'person@example.com',
        safe: 'ok',
      },
      list: [{ authorization: 'Bearer test' }, { count: 2 }],
    };

    const sanitized = Logger.sanitizeData(payload);

    expect(sanitized.userId).toBe('user-123');
    expect(sanitized.password).toBe('[REDACTED]');
    expect(sanitized.nested.token).toBe('[REDACTED]');
    expect(sanitized.nested.email).toBe('[REDACTED]');
    expect(sanitized.nested.safe).toBe('ok');
    expect(sanitized.list[0].authorization).toBe('[REDACTED]');
    expect(sanitized.list[1].count).toBe(2);
  });

  it('suppresses duplicate log entries within the rate-limit window', () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    Logger.setLevel(Logger.LOG_LEVELS.INFO);

    Logger.info('test', 'duplicate event');
    Logger.info('test', 'duplicate event');

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it('builds a persistable log payload with sanitized data', () => {
    const payload = Logger._buildPersistPayload(Logger.LOG_LEVELS.INFO, 'auth', 'login', {
      userId: 'user-123',
      password: 'secret',
      safe: 'ok',
    });

    expect(payload.itemType).toBe('LOG');
    expect(payload.level).toBe('INFO');
    expect(payload.context).toBe('auth');
    expect(payload.message).toBe('login');
    expect(payload.data.password).toBe('[REDACTED]');
    expect(payload.data.safe).toBe('ok');
  });
});
