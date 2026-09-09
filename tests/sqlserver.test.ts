import { describe, expect, it, vi } from 'vitest';
import { SqlServerCleaner } from '../src/sqlserver.js';
import type { SqlServerPoolLike, SqlServerRequestLike, SqlServerTransactionLike } from '../src/types.js';

describe('SqlServerCleaner', () => {
  it('uses parameterized binary-collation requests', async () => {
    const queries: string[] = [];
    const request: SqlServerRequestLike = {
      input: vi.fn(() => request),
      async query<T>(sql: string) {
        queries.push(sql);
        return sql.startsWith('SELECT') ? { recordset: [{ count: 1 } as T], rowsAffected: [1] } : { recordset: [], rowsAffected: [1] };
      }
    };
    const transaction: SqlServerTransactionLike = {
      begin: vi.fn(async () => undefined),
      request: () => request,
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined)
    };
    const pool: SqlServerPoolLike = { transaction: () => transaction };
    const results = await new SqlServerCleaner(pool).cleanup('testdata_20260909_sql01_', [{ name: 'orders', table: 'Orders', column: 'OrderNumber' }], false, () => undefined);
    expect(results[0]?.status).toBe('deleted');
    expect(queries.some((query) => query.includes('COLLATE') && query.includes('LIKE @prefix'))).toBe(true);
    expect(transaction.begin).toHaveBeenCalledOnce();
    expect(transaction.commit).toHaveBeenCalledOnce();
  });
});
