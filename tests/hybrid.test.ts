import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TestDataSweeper } from '../src/cleaner.js';
import type { PostgresClientLike, PostgresPoolLike } from '../src/types.js';

function poolFor(found: number, deleted: number): { pool: PostgresPoolLike; queries: string[] } {
  const queries: string[] = [];
  const client: PostgresClientLike = {
    async query<T>(sql: string): Promise<{ rows: T[]; rowCount: number | null }> {
      queries.push(sql);
      return sql.startsWith('SELECT') ? { rows: [{ count: found } as T], rowCount: 1 } : { rows: [], rowCount: deleted };
    },
    release: vi.fn()
  };
  return { pool: { connect: async () => client }, queries };
}

describe('hybrid cleanup', () => {
  it('uses DB fallback only for an unsupported API endpoint', async () => {
    const fake = poolFor(1, 1);
    const cleaner = new TestDataSweeper({
      cleanupEnabled: true,
      environment: 'qa',
      allowedEnvironments: ['qa'],
      dataDirectory: await mkdtemp(join(tmpdir(), 'qa-cleaner-hybrid-')),
      postgres: { databaseName: 'qa', pool: fake.pool, targets: [] },
      resources: {
        order: {
          strategy: 'hybrid',
          api: { deleteById: async () => ({ status: 405 }) },
          postgres: { name: 'orders', table: 'orders', column: 'order_number' },
          fallbackOnlyWhen: ['endpoint-not-supported']
        }
      }
    });
    const run = await cleaner.start({ prefix: 'testdata_20260909_hybrid01_' });
    await run.track({ resourceType: 'order', id: 'order-1' });
    const results = await cleaner.cleanupRun(run.runId, { execute: true });
    expect(results.some((result) => result.strategy === 'postgres' && result.status === 'deleted')).toBe(true);
    expect(fake.queries.some((query) => query.startsWith('DELETE'))).toBe(true);
  });

  it('does not silently fall back to DB for an API server error', async () => {
    const fake = poolFor(1, 1);
    const cleaner = new TestDataSweeper({
      cleanupEnabled: true,
      environment: 'qa',
      allowedEnvironments: ['qa'],
      dataDirectory: await mkdtemp(join(tmpdir(), 'qa-cleaner-hybrid-')),
      postgres: { databaseName: 'qa', pool: fake.pool, targets: [] },
      resources: {
        order: {
          strategy: 'hybrid',
          api: { deleteById: async () => ({ status: 500, message: 'server error' }) },
          postgres: { name: 'orders', table: 'orders', column: 'order_number' },
          fallbackOnlyWhen: ['endpoint-not-supported']
        }
      }
    });
    const run = await cleaner.start({ prefix: 'testdata_20260909_hybrid02_' });
    await run.track({ resourceType: 'order', id: 'order-1' });
    const results = await cleaner.cleanupRun(run.runId, { execute: true });
    expect(results[0]?.status).toBe('unresolved');
    expect(fake.queries.some((query) => query.startsWith('DELETE'))).toBe(false);
  });

  it('keeps unrelated global targets when a hybrid definition covers one target', async () => {
    const fake = poolFor(1, 1);
    const cleaner = new TestDataSweeper({
      cleanupEnabled: true,
      environment: 'qa',
      allowedEnvironments: ['qa'],
      dataDirectory: await mkdtemp(join(tmpdir(), 'testdata-sweeper-hybrid-')),
      postgres: {
        databaseName: 'qa',
        pool: fake.pool,
        targets: [
          { name: 'orders', table: 'orders', column: 'order_number' },
          { name: 'customers', table: 'customers', column: 'email' }
        ]
      },
      resources: {
        order: {
          strategy: 'hybrid',
          api: { deleteById: async () => ({ status: 405 }) },
          postgres: { name: 'orders', table: 'orders', column: 'order_number' },
          fallbackOnlyWhen: ['endpoint-not-supported']
        }
      }
    });
    const run = await cleaner.start({ prefix: 'testdata_20260909_hybrid04_' });
    await run.track({ resourceType: 'order', id: 'order-1' });

    const results = await cleaner.cleanupRun(run.runId, { execute: true });
    expect(results.map((result) => result.target)).toEqual(expect.arrayContaining(['orders', 'customers']));
  });

  it('marks the run unresolved when cleanup throws', async () => {
    const fake = poolFor(1, 1);
    const cleaner = new TestDataSweeper({
      cleanupEnabled: true,
      environment: 'qa',
      allowedEnvironments: ['qa'],
      dataDirectory: await mkdtemp(join(tmpdir(), 'testdata-sweeper-hybrid-')),
      postgres: { databaseName: 'qa', pool: fake.pool, targets: [] },
      resources: {
        order: {
          strategy: 'hybrid',
          api: { deleteById: async () => { throw new Error('network unavailable'); } },
          postgres: { name: 'orders', table: 'orders', column: 'order_number' }
        }
      }
    });
    const run = await cleaner.start({ prefix: 'testdata_20260909_hybrid03_' });
    await run.track({ resourceType: 'order', id: 'order-1' });

    await expect(cleaner.cleanupRun(run.runId, { execute: true })).rejects.toThrow('network unavailable');
    expect((await cleaner.registry.getManifest(run.runId)).status).toBe('unresolved');
  });
});
