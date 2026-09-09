import type { CleanupResult, SqlServerPoolLike, SqlServerTarget } from './types.js';
import { assertSafeIdentifier } from './guards.js';
import { assertPrefix, escapeLikePrefix } from './prefix.js';

export async function createSqlServerPool(connectionString: string): Promise<SqlServerPoolLike> {
  const sql = await import('mssql');
  return sql.default.connect(connectionString) as unknown as Promise<SqlServerPoolLike>;
}

function quoteIdentifier(identifier: string): string {
  assertSafeIdentifier(identifier, 'table');
  return `[${identifier.replaceAll(']', ']]')}]`;
}

export class SqlServerCleaner {
  public constructor(private readonly pool: SqlServerPoolLike, private readonly closePool = false) {}

  public async cleanup(prefix: string, targets: SqlServerTarget[], dryRun: boolean, logger: (event: string, fields: Record<string, unknown>) => void): Promise<CleanupResult[]> {
    assertPrefix(prefix);
    const transaction = this.pool.transaction();
    const results: CleanupResult[] = [];
    try {
      if (!dryRun) await transaction.begin();
      for (const target of orderTargets(targets)) {
        const started = Date.now();
        const table = quoteIdentifier(target.table);
        const column = quoteIdentifier(target.column);
        const request = transaction.request().input('prefix', escapeLikePrefix(prefix));
        const predicate = `${column} COLLATE Latin1_General_100_BIN2 LIKE @prefix ESCAPE '\\'`;
        const countResult = await request.query<{ count: number }>(`SELECT COUNT_BIG(*) AS [count] FROM ${table} WHERE ${predicate}`);
        const found = Number(countResult.recordset[0]?.count ?? 0);
        if (target.maxDeleteCount !== undefined && found > target.maxDeleteCount) {
          throw new Error(`SQL Server target ${target.name} matched ${found}, above maxDeleteCount ${target.maxDeleteCount}.`);
        }
        if (dryRun) {
          const result: CleanupResult = { target: target.name, strategy: 'sqlserver', found, deleted: 0, dryRun: true, status: found === 0 ? 'already-absent' : 'dry-run', durationMs: Date.now() - started };
          results.push(result);
          logger('cleanup.target', { database: 'sqlserver', ...result });
          continue;
        }
        const deleteResult = await transaction.request().input('prefix', escapeLikePrefix(prefix)).query(`DELETE FROM ${table} WHERE ${predicate}`);
        const deleted = Number(deleteResult.rowsAffected[0] ?? 0);
        const result: CleanupResult = { target: target.name, strategy: 'sqlserver', found, deleted, dryRun: false, status: deleted === 0 ? 'already-absent' : 'deleted', durationMs: Date.now() - started };
        results.push(result);
        logger('cleanup.target', { database: 'sqlserver', ...result });
      }
      if (!dryRun) await transaction.commit();
      return results;
    } catch (error) {
      if (!dryRun) await transaction.rollback().catch(() => undefined);
      throw error;
    } finally {
      if (this.closePool && this.pool.close) await this.pool.close();
    }
  }
}

function orderTargets(targets: SqlServerTarget[]): SqlServerTarget[] {
  const byName = new Map(targets.map((target) => [target.name, target]));
  const ordered: SqlServerTarget[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(name: string): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`SQL Server cleanup dependency cycle at ${name}.`);
    const target = byName.get(name);
    if (!target) throw new Error(`Unknown SQL Server cleanup dependency: ${name}.`);
    visiting.add(name);
    for (const dependency of target.dependsOn ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    ordered.push(target);
  }
  for (const target of targets) visit(target.name);
  return ordered;
}
