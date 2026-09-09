import type { CleanupResult, MySqlPoolLike, MySqlTarget } from './types.js';
import { assertSafeIdentifier } from './guards.js';
import { assertPrefix, escapeLikePrefix } from './prefix.js';

export async function createMySqlPool(connectionString: string): Promise<MySqlPoolLike> {
  const mysql = await import('mysql2/promise');
  return mysql.createPool(connectionString) as unknown as MySqlPoolLike;
}

function quoteIdentifier(identifier: string): string {
  assertSafeIdentifier(identifier, 'table');
  return `\`${identifier.replaceAll('`', '``')}\``;
}

export class MySqlCleaner {
  public constructor(private readonly pool: MySqlPoolLike, private readonly closePool = false) {}

  public async cleanup(prefix: string, targets: MySqlTarget[], dryRun: boolean, logger: (event: string, fields: Record<string, unknown>) => void): Promise<CleanupResult[]> {
    assertPrefix(prefix);
    const connection = await this.pool.getConnection();
    const results: CleanupResult[] = [];
    try {
      if (!dryRun) await connection.beginTransaction();
      for (const target of orderTargets(targets)) {
        const started = Date.now();
        const table = quoteIdentifier(target.table);
        const column = quoteIdentifier(target.column);
        const pattern = escapeLikePrefix(prefix);
        const [rows] = await connection.query<{ count: number | string }>(
          `SELECT COUNT(*) AS count FROM ${table} WHERE BINARY ${column} LIKE ? ESCAPE '\\'`,
          [pattern]
        );
        const found = Number(rows[0]?.count ?? 0);
        if (target.maxDeleteCount !== undefined && found > target.maxDeleteCount) {
          throw new Error(`MySQL target ${target.name} matched ${found}, above maxDeleteCount ${target.maxDeleteCount}.`);
        }
        if (dryRun) {
          const result: CleanupResult = { target: target.name, strategy: 'mysql', found, deleted: 0, dryRun: true, status: found === 0 ? 'already-absent' : 'dry-run', durationMs: Date.now() - started };
          results.push(result);
          logger('cleanup.target', { database: 'mysql', ...result });
          continue;
        }
        const [, metadata] = await connection.query(`DELETE FROM ${table} WHERE BINARY ${column} LIKE ? ESCAPE '\\'`, [pattern]);
        const deleted = Number((metadata as { affectedRows?: number }).affectedRows ?? 0);
        const result: CleanupResult = { target: target.name, strategy: 'mysql', found, deleted, dryRun: false, status: deleted === 0 ? 'already-absent' : 'deleted', durationMs: Date.now() - started };
        results.push(result);
        logger('cleanup.target', { database: 'mysql', ...result });
      }
      if (!dryRun) await connection.commit();
      return results;
    } catch (error) {
      if (!dryRun) await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
      if (this.closePool && this.pool.end) await this.pool.end();
    }
  }
}

function orderTargets(targets: MySqlTarget[]): MySqlTarget[] {
  const byName = new Map(targets.map((target) => [target.name, target]));
  const ordered: MySqlTarget[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(name: string): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`MySQL cleanup dependency cycle at ${name}.`);
    const target = byName.get(name);
    if (!target) throw new Error(`Unknown MySQL cleanup dependency: ${name}.`);
    visiting.add(name);
    for (const dependency of target.dependsOn ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    ordered.push(target);
  }
  for (const target of targets) visit(target.name);
  return ordered;
}
