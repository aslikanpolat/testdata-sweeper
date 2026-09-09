import { describe, expect, it, vi } from 'vitest';
import { MySqlCleaner } from '../src/mysql.js';
import type { MySqlConnectionLike, MySqlPoolLike } from '../src/types.js';

describe('MySqlCleaner', () => {
  it('uses parameterized binary prefix deletes and transactions', async () => {
    const queries: string[] = [];
    const connection: MySqlConnectionLike = {
      beginTransaction: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      release: vi.fn(),
      async query<T>(sql: string): Promise<[T[], unknown]> {
        queries.push(sql);
        if (sql.startsWith('SELECT')) return [[{ count: 2 } as T], {}];
        return [[], { affectedRows: 2 }];
      }
    };
    const pool: MySqlPoolLike = { getConnection: async () => connection };
    const results = await new MySqlCleaner(pool).cleanup('testdata_20260909_mysql01_', [{ name: 'orders', table: 'orders', column: 'order_number' }], false, () => undefined);
    expect(results[0]?.status).toBe('deleted');
    expect(queries.some((query) => query.includes('BINARY') && query.includes('LIKE ?'))).toBe(true);
    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    expect(connection.commit).toHaveBeenCalledOnce();
  });
});
