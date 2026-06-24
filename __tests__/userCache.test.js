const { UserCache } = require('../utils/userCache');

describe('UserCache', () => {
  it('deduplicates concurrent loads for the same user', async () => {
    const cache = new UserCache(60_000, 50);
    let loaderCalls = 0;

    const loader = async () => {
      loaderCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { userId: 'user-1', userName: 'Ada' };
    };

    const [first, second, third] = await Promise.all([
      cache.getOrLoad('user-1', loader),
      cache.getOrLoad('user-1', loader),
      cache.getOrLoad('user-1', loader),
    ]);

    expect(loaderCalls).toBe(1);
    expect(first).toEqual({ userId: 'user-1', userName: 'Ada' });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(cache.get('user-1')).toEqual(first);
  });
});
