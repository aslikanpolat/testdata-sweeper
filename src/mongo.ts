import { createRequire } from 'node:module';
import type { CleanupResult, MongoClientLike, MongoTarget } from './types.js';
import { assertSafeIdentifier } from './guards.js';
import { assertPrefix, escapeRegex } from './prefix.js';

const require = createRequire(import.meta.url);

export function createMongoClient(connectionString: string): MongoClientLike {
  const { MongoClient } = require('mongodb') as typeof import('mongodb');
  return new MongoClient(connectionString) as unknown as MongoClientLike;
}

export class MongoCleaner {
  public constructor(private readonly client: MongoClientLike, private readonly databaseName: string, private readonly closeClient = false) {}

  public async cleanup(prefix: string, targets: MongoTarget[], dryRun: boolean, logger: (event: string, fields: Record<string, unknown>) => void): Promise<CleanupResult[]> {
    assertPrefix(prefix);
    await this.client.connect();
    const results: CleanupResult[] = [];
    try {
      const ordered = orderTargets(targets);
      for (const target of ordered) {
        assertSafeIdentifier(target.collection, 'collection');
        assertSafeIdentifier(target.field, 'column');
        const filter = { [target.field]: { $regex: `^${escapeRegex(prefix)}` } };
        const collection = this.client.db(this.databaseName).collection(target.collection);
        const started = Date.now();
        const found = await collection.countDocuments(filter);
        if (target.maxDeleteCount !== undefined && found > target.maxDeleteCount) {
          throw new Error(`MongoDB target ${target.name} matched ${found}, above maxDeleteCount ${target.maxDeleteCount}.`);
        }
        const deleted = dryRun ? 0 : (await collection.deleteMany(filter)).deletedCount;
        const result: CleanupResult = { target: target.name, strategy: 'mongo', found, deleted, dryRun, status: dryRun ? (found === 0 ? 'already-absent' : 'dry-run') : (deleted === 0 ? 'already-absent' : 'deleted'), durationMs: Date.now() - started };
        results.push(result);
        logger('cleanup.target', { database: 'mongo', ...result });
      }
      return results;
    } finally {
      if (this.closeClient) await this.client.close();
    }
  }
}

function orderTargets(targets: MongoTarget[]): MongoTarget[] {
  const byName = new Map(targets.map((target) => [target.name, target]));
  const ordered: MongoTarget[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(name: string): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`MongoDB cleanup dependency cycle at ${name}.`);
    const target = byName.get(name);
    if (!target) throw new Error(`Unknown MongoDB cleanup dependency: ${name}.`);
    visiting.add(name);
    for (const dependency of target.dependsOn ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    ordered.push(target);
  }
  for (const target of targets) visit(target.name);
  return ordered;
}
