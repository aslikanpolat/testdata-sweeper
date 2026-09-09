import type { CleanupResult, RedisClientLike, RedisTarget } from './types.js';
import { assertPrefix } from './prefix.js';

export async function createRedisClient(connectionString: string): Promise<RedisClientLike> {
  const redis = await import('redis');
  const client = redis.createClient({ url: connectionString });
  await client.connect();
  return client as unknown as RedisClientLike;
}

function escapeRedisPattern(value: string): string {
  return value.replace(/[\\*?[\]]/g, '\\$&');
}

export class RedisCleaner {
  public constructor(private readonly client: RedisClientLike, private readonly closeClient = false) {}

  public async cleanup(prefix: string, targets: RedisTarget[], dryRun: boolean, logger: (event: string, fields: Record<string, unknown>) => void): Promise<CleanupResult[]> {
    assertPrefix(prefix);
    const results: CleanupResult[] = [];
    try {
      for (const target of orderTargets(targets)) {
        const started = Date.now();
        const keyPrefix = target.keyPrefix ?? prefix;
        if (!keyPrefix.startsWith(prefix)) throw new Error(`Redis target ${target.name} keyPrefix must start with the current run prefix.`);
        const keys = new Set<string>();
        for await (const key of this.client.scanIterator({ MATCH: `${escapeRedisPattern(keyPrefix)}*`, COUNT: target.scanCount ?? 100 })) keys.add(key);
        const found = keys.size;
        if (target.maxDeleteCount !== undefined && found > target.maxDeleteCount) {
          throw new Error(`Redis target ${target.name} matched ${found}, above maxDeleteCount ${target.maxDeleteCount}.`);
        }
        let deleted = 0;
        if (!dryRun) {
          const batch = [...keys];
          for (let index = 0; index < batch.length; index += 500) deleted += await this.client.unlink(...batch.slice(index, index + 500));
        }
        const result: CleanupResult = { target: target.name, strategy: 'redis', found, deleted, dryRun, status: dryRun ? (found === 0 ? 'already-absent' : 'dry-run') : (deleted === 0 ? 'already-absent' : 'deleted'), durationMs: Date.now() - started };
        results.push(result);
        logger('cleanup.target', { database: 'redis', ...result });
      }
      return results;
    } finally {
      if (this.closeClient && this.client.quit) await this.client.quit();
    }
  }
}

function orderTargets(targets: RedisTarget[]): RedisTarget[] {
  const byName = new Map(targets.map((target) => [target.name, target]));
  const ordered: RedisTarget[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(name: string): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Redis cleanup dependency cycle at ${name}.`);
    const target = byName.get(name);
    if (!target) throw new Error(`Unknown Redis cleanup dependency: ${name}.`);
    visiting.add(name);
    for (const dependency of target.dependsOn ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    ordered.push(target);
  }
  for (const target of targets) visit(target.name);
  return ordered;
}
