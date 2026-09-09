import { describe, expect, it, vi } from 'vitest';
import { PostgresCleaner } from '../src/postgres.js';
import type { PostgresClientLike, PostgresPoolLike } from '../src/types.js';

function fakePostgres(found = 2, deleted = 2): { pool: PostgresPoolLike; queries: string[] } {
  const queries: string[] = [];
  const client: PostgresClientLike = {
    async query<T>(sql: string): Promise<{ rows: T[]; rowCount: number | null }> {
      queries.push(sql);
      if (sql.startsWith('SELECT')) return { rows: [{ count: found } as T], rowCount: 1 };
      return { rows: [], rowCount: deleted };
    },
    release: vi.fn()
  };
  return { pool: { connect: async () => client }, queries };
}

describe('PostgresCleaner', () => {
  it('uses parameterized prefix deletes and child-before-parent order', async () => {
    const fake = fakePostgres();
    const results = await new PostgresCleaner(fake.pool).cleanup('testdata_20260909_abc12345_', [
      { name: 'orders', table: 'orders', column: 'order_number', dependsOn: ['order_items'] },
      { name: 'order_items', table: 'order_items', column: 'order_number' }
    ], false, () => undefined);
    expect(results.map((result) => result.target)).toEqual(['order_items', 'orders']);
    expect(fake.queries.some((query) => query.includes('SELECT'))).toBe(true);
    expect(fake.queries.some((query) => query.includes('LIKE $1'))).toBe(true);
    expect(fake.queries.some((query) => query.includes('BEGIN'))).toBe(true);
    expect(fake.queries.some((query) => query.includes('COMMIT'))).toBe(true);
  });

  it('does not delete during dry-run', async () => {
    const fake = fakePostgres(3, 0);
    const results = await new PostgresCleaner(fake.pool).cleanup('testdata_20260909_abc12345_', [{ name: 'orders', table: 'orders', column: 'order_number' }], true, () => undefined);
    expect(results[0]?.status).toBe('dry-run');
    expect(fake.queries.some((query) => query.startsWith('DELETE'))).toBe(false);
  });
});
