import { describe, expect, it, vi } from 'vitest';
import { RedisCleaner } from '../src/redis.js';
import type { RedisClientLike } from '../src/types.js';

describe('RedisCleaner', () => {
  it('uses SCAN MATCH and batched UNLINK, never keyspace-wide commands', async () => {
    const unlink = vi.fn(async (...keys: string[]) => keys.length);
    const client: RedisClientLike = {
      scanIterator: () => (async function* () {
        yield 'testdata_20260909_redis01_order:1';
        yield 'testdata_20260909_redis01_order:2';
        yield 'testdata_20260909_redis01_order:2';
      })(),
      unlink
    };
    const results = await new RedisCleaner(client).cleanup('testdata_20260909_redis01_', [{ name: 'orders', maxDeleteCount: 10 }], false, () => undefined);
    expect(results[0]?.deleted).toBe(2);
    expect(unlink).toHaveBeenCalledWith('testdata_20260909_redis01_order:1', 'testdata_20260909_redis01_order:2');
  });

  it('rejects a key prefix outside the current run prefix', async () => {
    const client: RedisClientLike = {
      scanIterator: () => (async function* () { yield 'other-key'; })(),
      unlink: async () => 1
    };
    await expect(new RedisCleaner(client).cleanup('testdata_20260909_redis01_', [{ name: 'unsafe', keyPrefix: 'other_' }], false, () => undefined)).rejects.toThrow(/must start/);
  });
});
