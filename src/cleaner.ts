import { createMongoClient, MongoCleaner } from './mongo.js';
import { consoleLogger } from './logger.js';
import { createPostgresPool, PostgresCleaner } from './postgres.js';
import { createMySqlPool, MySqlCleaner } from './mysql.js';
import { createSqlServerPool, SqlServerCleaner } from './sqlserver.js';
import { createRedisClient, RedisCleaner } from './redis.js';
import { FileRegistry } from './registry.js';
import { createPrefix } from './prefix.js';
import { assertCleanupAllowed, databaseFingerprint } from './guards.js';
import { createRunContext, type RunContext } from './run.js';
import type { CleanupResult, ResourceDefinition, ResourceRecord, TestDataSweeperConfig } from './types.js';

export class TestDataSweeper {
  public readonly registry: FileRegistry;
  private readonly logger;

  public constructor(public readonly config: TestDataSweeperConfig) {
    assertCleanupAllowed(config);
    this.registry = new FileRegistry(config.dataDirectory);
    this.logger = config.logger ?? consoleLogger;
  }

  public async start(options: { prefix?: string } = {}): Promise<RunContext> {
    const prefix = options.prefix ?? createPrefix();
    const fingerprints = [
      ...(this.config.postgres ? [databaseFingerprint('postgres', this.config.postgres)] : []),
      ...(this.config.mysql ? [databaseFingerprint('mysql', this.config.mysql)] : []),
      ...(this.config.sqlserver ? [databaseFingerprint('sqlserver', this.config.sqlserver)] : []),
      ...(this.config.redis ? [databaseFingerprint('redis', this.config.redis)] : []),
      ...(this.config.mongo ? [databaseFingerprint('mongo', this.config.mongo)] : [])
    ];
    return createRunContext(this.registry, prefix, this.config.environment, this.config.tenant, fingerprints);
  }

  public async cleanupRun(runId: string, options: { dryRun?: boolean; execute?: boolean } = {}): Promise<CleanupResult[]> {
    const manifest = await this.registry.getManifest(runId);
    this.assertManifestOwnership(manifest);
    if (!options.execute && options.dryRun !== true) options = { ...options, dryRun: true };
    const dryRun = options.dryRun === true && options.execute !== true;
    assertCleanupAllowed(this.config);
    const results: CleanupResult[] = [];
    try {
      const records = await this.registry.getRecords(runId);
      const definitions = this.config.resources ?? {};
      const recordGroups = groupRecords(records);

      for (const [resourceType, definition] of Object.entries(definitions)) {
        const resourceRecords = effectiveRecords(recordGroups.get(resourceType) ?? []);
        const result = await this.cleanupDefinition(manifest, definition, resourceRecords, dryRun);
        results.push(...result);
      }

      const postgresTargetNames = targetNamesCoveredByDefinitions(definitions, 'postgres');
      const mysqlTargetNames = targetNamesCoveredByDefinitions(definitions, 'mysql');
      const sqlserverTargetNames = targetNamesCoveredByDefinitions(definitions, 'sqlserver');
      const mongoTargetNames = targetNamesCoveredByDefinitions(definitions, 'mongo');
      const redisTargetNames = targetNamesCoveredByDefinitions(definitions, 'redis');

      if (this.config.postgres) {
        const targets = this.config.postgres.targets.filter((target) => !postgresTargetNames.has(target.name));
        if (targets.length > 0) results.push(...await this.createPostgresCleaner().cleanup(manifest.prefix, targets, dryRun, (event, fields) => this.logger.info(event, { runId, ...fields })));
      }
      if (this.config.mysql) {
        const targets = this.config.mysql.targets.filter((target) => !mysqlTargetNames.has(target.name));
        if (targets.length > 0) results.push(...await (await this.createMySqlCleaner()).cleanup(manifest.prefix, targets, dryRun, (event, fields) => this.logger.info(event, { runId, ...fields })));
      }
      if (this.config.sqlserver) {
        const targets = this.config.sqlserver.targets.filter((target) => !sqlserverTargetNames.has(target.name));
        if (targets.length > 0) results.push(...await (await this.createSqlServerCleaner()).cleanup(manifest.prefix, targets, dryRun, (event, fields) => this.logger.info(event, { runId, ...fields })));
      }
      if (this.config.mongo) {
        const targets = this.config.mongo.targets.filter((target) => !mongoTargetNames.has(target.name));
        const client = this.config.mongo.client ?? createMongoClient(this.config.mongo.connectionString ?? missing('MongoDB connection string'));
        if (targets.length > 0) results.push(...await this.createMongoCleaner(client, this.config.mongo.databaseName, this.config.mongo.client === undefined).cleanup(manifest.prefix, targets, dryRun, (event, fields) => this.logger.info(event, { runId, ...fields })));
      }
      if (this.config.redis) {
        const targets = this.config.redis.targets.filter((target) => !redisTargetNames.has(target.name));
        if (targets.length > 0) results.push(...await (await this.createRedisCleaner()).cleanup(manifest.prefix, targets, dryRun, (event, fields) => this.logger.info(event, { runId, ...fields })));
      }

      const unresolved = results.some((result) => result.status === 'failed' || result.status === 'unresolved' || result.status === 'ambiguous');
      await this.registry.updateManifest(runId, { status: dryRun ? 'cleanup-pending' : (unresolved ? 'unresolved' : 'clean') });
      return results;
    } catch (error) {
      await this.registry.updateManifest(runId, { status: dryRun ? 'cleanup-pending' : 'unresolved' }).catch((updateError: unknown) => {
        this.logger.error('cleanup.manifest-update-failed', { runId, error: updateError instanceof Error ? updateError.message : String(updateError) });
      });
      throw error;
    }
  }

  private assertManifestOwnership(manifest: Awaited<ReturnType<FileRegistry['getManifest']>>): void {
    if (manifest.environment.toLowerCase() !== this.config.environment.toLowerCase()) {
      throw new Error(`Manifest environment ${manifest.environment} does not match configured environment ${this.config.environment}.`);
    }
    const expected = [
      ...(this.config.postgres ? [databaseFingerprint('postgres', this.config.postgres)] : []),
      ...(this.config.mysql ? [databaseFingerprint('mysql', this.config.mysql)] : []),
      ...(this.config.sqlserver ? [databaseFingerprint('sqlserver', this.config.sqlserver)] : []),
      ...(this.config.redis ? [databaseFingerprint('redis', this.config.redis)] : []),
      ...(this.config.mongo ? [databaseFingerprint('mongo', this.config.mongo)] : [])
    ];
    const actual = [...manifest.databaseFingerprints].sort();
    const sortedExpected = expected.sort();
    if (sortedExpected.length !== actual.length || sortedExpected.some((fingerprint, index) => fingerprint !== actual[index])) {
      throw new Error('Manifest database fingerprint does not match the current cleanup configuration.');
    }
  }

  private async cleanupDefinition(manifest: Awaited<ReturnType<FileRegistry['getManifest']>>, definition: ResourceDefinition, records: ResourceRecord[], dryRun: boolean): Promise<CleanupResult[]> {
    if (definition.strategy === 'api' || definition.strategy === 'hybrid') {
      if (definition.strategy === 'hybrid' && records.length === 0) {
        return this.cleanupHybridFallback(manifest, definition, dryRun);
      }
      const apiResults: CleanupResult[] = [];
      let fallbackRequested = false;
      const fallbackAllowed = definition.strategy === 'hybrid' && (definition.fallbackOnlyWhen === undefined || definition.fallbackOnlyWhen.includes('endpoint-not-supported'));
      for (const resource of records) {
        if (!resource.id) {
          apiResults.push({ target: resource.resourceType, strategy: definition.strategy, found: 1, deleted: 0, dryRun, status: 'unresolved', durationMs: 0, error: 'API cleanup requires an exact resource id.' });
          continue;
        }
        const started = Date.now();
        if (dryRun) {
          apiResults.push({ target: resource.resourceType, strategy: definition.strategy, found: 1, deleted: 0, dryRun: true, status: 'dry-run', durationMs: Date.now() - started });
          continue;
        }
        const response = await definition.api.deleteById(resource.id, { runId: manifest.runId, prefix: manifest.prefix, resource });
        if (response.status === 404) {
          apiResults.push({ target: resource.resourceType, strategy: definition.strategy, found: 1, deleted: 0, dryRun: false, status: 'already-absent', durationMs: Date.now() - started });
          continue;
        }
        if (response.status === 405 && definition.strategy === 'hybrid' && fallbackAllowed) {
          fallbackRequested = true;
          continue;
        }
        if (response.status === 405 && definition.strategy === 'hybrid') {
          apiResults.push({ target: resource.resourceType, strategy: 'hybrid', found: 1, deleted: 0, dryRun: false, status: 'unresolved', durationMs: Date.now() - started, error: 'API unsupported and DB fallback is not enabled for this resource.' });
          continue;
        }
        if (response.status >= 400) {
          apiResults.push({ target: resource.resourceType, strategy: definition.strategy, found: 1, deleted: 0, dryRun: false, status: 'unresolved', durationMs: Date.now() - started, error: response.message ?? `API returned ${response.status}.` });
          continue;
        }
        apiResults.push({ target: resource.resourceType, strategy: definition.strategy, found: 1, deleted: 1, dryRun: false, status: 'deleted', durationMs: Date.now() - started });
      }
      if (fallbackRequested) apiResults.push(...await this.cleanupHybridFallback(manifest, definition, false));
      return apiResults;
    }

    if (definition.strategy === 'postgres') return this.createPostgresCleaner().cleanup(manifest.prefix, [definition.postgres], dryRun, (event, fields) => this.logger.info(event, { runId: manifest.runId, ...fields }));
    if (definition.strategy === 'mysql') return (await this.createMySqlCleaner()).cleanup(manifest.prefix, [definition.mysql], dryRun, (event, fields) => this.logger.info(event, { runId: manifest.runId, ...fields }));
    if (definition.strategy === 'sqlserver') return (await this.createSqlServerCleaner()).cleanup(manifest.prefix, [definition.sqlserver], dryRun, (event, fields) => this.logger.info(event, { runId: manifest.runId, ...fields }));
    if (definition.strategy === 'mongo') return this.createMongoCleanerForConfig().cleanup(manifest.prefix, [definition.mongo], dryRun, (event, fields) => this.logger.info(event, { runId: manifest.runId, ...fields }));
    if (definition.strategy === 'redis') return (await this.createRedisCleaner()).cleanup(manifest.prefix, [definition.redis], dryRun, (event, fields) => this.logger.info(event, { runId: manifest.runId, ...fields }));
    throw new Error(`Unsupported cleanup strategy: ${definition.strategy}`);
  }

  private createPostgresCleaner(): PostgresCleaner {
    const pool = this.config.postgres?.pool ?? createPostgresPool(this.config.postgres?.connectionString ?? missing('PostgreSQL pool or connection string'));
    return new PostgresCleaner(pool, this.config.postgres?.pool === undefined);
  }

  private async createMySqlCleaner(): Promise<MySqlCleaner> {
    const pool = this.config.mysql?.pool ?? await createMySqlPool(this.config.mysql?.connectionString ?? missing('MySQL pool or connection string'));
    return new MySqlCleaner(pool, this.config.mysql?.pool === undefined);
  }

  private async createSqlServerCleaner(): Promise<SqlServerCleaner> {
    const pool = this.config.sqlserver?.pool ?? await createSqlServerPool(this.config.sqlserver?.connectionString ?? missing('SQL Server pool or connection string'));
    return new SqlServerCleaner(pool, this.config.sqlserver?.pool === undefined);
  }

  private async createRedisCleaner(): Promise<RedisCleaner> {
    const client = this.config.redis?.client ?? await createRedisClient(this.config.redis?.connectionString ?? missing('Redis client or connection string'));
    return new RedisCleaner(client, this.config.redis?.client === undefined);
  }

  private createMongoCleaner(client: ReturnType<typeof createMongoClient>, databaseName: string, closeClient: boolean): MongoCleaner {
    return new MongoCleaner(client, databaseName, closeClient);
  }

  private createMongoCleanerForConfig(): MongoCleaner {
    const client = this.config.mongo?.client ?? createMongoClient(this.config.mongo?.connectionString ?? missing('MongoDB connection string'));
    return this.createMongoCleaner(client, this.config.mongo?.databaseName ?? missing('MongoDB database name'), this.config.mongo?.client === undefined);
  }

  private cleanupHybridFallback(manifest: Awaited<ReturnType<FileRegistry['getManifest']>>, definition: ResourceDefinition, dryRun: boolean): Promise<CleanupResult[]> {
    if (definition.strategy !== 'hybrid') return Promise.resolve([]);
    if (definition.postgres) return this.createPostgresCleaner().cleanup(manifest.prefix, [definition.postgres], dryRun, (event, fields) => this.logger.info(event, { runId: manifest.runId, ...fields }));
    if (definition.mysql) return this.createMySqlCleaner().then((cleaner) => cleaner.cleanup(manifest.prefix, [definition.mysql!], dryRun, (event, fields) => this.logger.info(event, { runId: manifest.runId, ...fields })));
    if (definition.sqlserver) return this.createSqlServerCleaner().then((cleaner) => cleaner.cleanup(manifest.prefix, [definition.sqlserver!], dryRun, (event, fields) => this.logger.info(event, { runId: manifest.runId, ...fields })));
    if (definition.mongo) return this.createMongoCleanerForConfig().cleanup(manifest.prefix, [definition.mongo], dryRun, (event, fields) => this.logger.info(event, { runId: manifest.runId, ...fields }));
    if (definition.redis) return this.createRedisCleaner().then((cleaner) => cleaner.cleanup(manifest.prefix, [definition.redis!], dryRun, (event, fields) => this.logger.info(event, { runId: manifest.runId, ...fields })));
    return Promise.resolve([{ target: 'hybrid', strategy: 'hybrid', found: 0, deleted: 0, dryRun, status: 'unresolved', durationMs: 0, error: 'API unsupported and no DB fallback configured.' }]);
  }
}

function effectiveRecords(records: ResourceRecord[]): ResourceRecord[] {
  const createdKeys = new Set(records.filter((record) => record.status !== 'intent').flatMap((record) => [record.operationId, record.id].filter((value): value is string => Boolean(value))));
  return records.filter((record) => record.status !== 'intent' || ![record.operationId, record.id].some((key) => key !== undefined && createdKeys.has(key)));
}

function groupRecords(records: ResourceRecord[]): Map<string, ResourceRecord[]> {
  const groups = new Map<string, ResourceRecord[]>();
  for (const record of records) groups.set(record.resourceType, [...(groups.get(record.resourceType) ?? []), record]);
  return groups;
}

function targetNamesCoveredByDefinitions(definitions: Record<string, ResourceDefinition>, provider: 'postgres' | 'mysql' | 'sqlserver' | 'mongo' | 'redis'): Set<string> {
  const names = new Set<string>();
  for (const definition of Object.values(definitions)) {
    if (definition.strategy !== 'hybrid' && definition.strategy !== provider) continue;
    const target = provider === 'postgres' && 'postgres' in definition ? definition.postgres
      : provider === 'mysql' && 'mysql' in definition ? definition.mysql
        : provider === 'sqlserver' && 'sqlserver' in definition ? definition.sqlserver
          : provider === 'mongo' && 'mongo' in definition ? definition.mongo
            : provider === 'redis' && 'redis' in definition ? definition.redis
              : undefined;
    if (target) names.add(target.name);
  }
  return names;
}

function missing(name: string): never {
  throw new Error(`${name} is required for the selected cleanup strategy.`);
}
