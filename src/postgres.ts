import { createRequire } from 'node:module';
import type { CleanupResult, PostgresPoolLike, PostgresTarget } from './types.js';
import { assertSafeIdentifier } from './guards.js';
import { assertPrefix, escapeLikePrefix } from './prefix.js';

const require = createRequire(import.meta.url);

export function createPostgresPool(connectionString: string): PostgresPoolLike {
  const { Pool } = require('pg') as typeof import('pg');
  return new Pool({ connectionString }) as unknown as PostgresPoolLike;
}

function quoteIdentifier(identifier: string): string {
  assertSafeIdentifier(identifier, identifier === identifier.toLowerCase() ? 'table' : 'column');
  return `"${identifier.replaceAll('"', '""')}"`;
}

export class PostgresCleaner {
  public constructor(private readonly pool: PostgresPoolLike, private readonly closePool = false) {}

  public async cleanup(prefix: string, targets: PostgresTarget[], dryRun: boolean, logger: (event: string, fields: Record<string, unknown>) => void): Promise<CleanupResult[]> {
    assertPrefix(prefix);
    const ordered = orderTargets(targets);
    const client = await this.pool.connect();
    const results: CleanupResult[] = [];
    const started = Date.now();
    try {
      if (!dryRun) await client.query('BEGIN');
      for (const target of ordered) {
        const targetStarted = Date.now();
        const table = quoteIdentifier(target.table);
        const column = quoteIdentifier(target.column);
        const pattern = escapeLikePrefix(prefix);
        const countResult = await client.query<{ count: number | string }>(
          `SELECT count(*)::int AS count FROM ${table} WHERE ${column} LIKE $1 ESCAPE '\\'`,
          [pattern]
        );
        const found = Number(countResult.rows[0]?.count ?? 0);
        if (target.maxDeleteCount !== undefined && found > target.maxDeleteCount) {
          throw new Error(`PostgreSQL target ${target.name} matched ${found}, above maxDeleteCount ${target.maxDeleteCount}.`);
        }
        if (dryRun) {
          const result: CleanupResult = { target: target.name, strategy: 'postgres', found, deleted: 0, dryRun: true, status: found === 0 ? 'already-absent' : 'dry-run', durationMs: Date.now() - targetStarted };
          results.push(result);
          logger('cleanup.target', { database: 'postgres', ...result });
          continue;
        }
        const deletedResult = await client.query(`DELETE FROM ${table} WHERE ${column} LIKE $1 ESCAPE '\\'`, [pattern]);
        const deleted = deletedResult.rowCount ?? 0;
        const result: CleanupResult = { target: target.name, strategy: 'postgres', found, deleted, dryRun: false, status: deleted === 0 ? 'already-absent' : 'deleted', durationMs: Date.now() - targetStarted };
        results.push(result);
        logger('cleanup.target', { database: 'postgres', ...result });
      }
      if (!dryRun) await client.query('COMMIT');
      logger('cleanup.complete', { database: 'postgres', prefix, durationMs: Date.now() - started });
      return results;
    } catch (error) {
      if (!dryRun) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
      if (this.closePool && this.pool.end) await this.pool.end();
    }
  }
}

function orderTargets(targets: PostgresTarget[]): PostgresTarget[] {
  const byName = new Map(targets.map((target) => [target.name, target]));
  const ordered: PostgresTarget[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(name: string): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`PostgreSQL cleanup dependency cycle at ${name}.`);
    const target = byName.get(name);
    if (!target) throw new Error(`Unknown PostgreSQL cleanup dependency: ${name}.`);
    visiting.add(name);
    for (const dependency of target.dependsOn ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    ordered.push(target);
  }

  for (const target of targets) visit(target.name);
  return ordered;
}
