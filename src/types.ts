export type CleanupStrategy = 'api' | 'postgres' | 'mysql' | 'sqlserver' | 'mongo' | 'redis' | 'hybrid';
export type CleanupStatus = 'deleted' | 'dry-run' | 'already-absent' | 'unresolved' | 'ambiguous' | 'failed';

export interface CleanupResult {
  target: string;
  strategy: CleanupStrategy;
  found: number;
  deleted: number;
  dryRun: boolean;
  status: CleanupStatus;
  durationMs: number;
  error?: string;
}

export interface ResourceRecord {
  resourceType: string;
  id?: string;
  operationId?: string;
  target?: string;
  dependsOn?: string[];
  createdAt: string;
  status: 'intent' | 'created' | 'cleanup-pending' | 'clean' | 'unresolved';
}

export interface RunManifest {
  schemaVersion: 1;
  runId: string;
  prefix: string;
  environment: string;
  tenant?: string;
  databaseFingerprints: string[];
  status: 'active' | 'cleanup-pending' | 'clean' | 'unresolved';
  createdAt: string;
  updatedAt: string;
  heartbeatAt: string;
}

export interface PostgresTarget {
  name: string;
  table: string;
  column: string;
  idColumn?: string;
  dependsOn?: string[];
  maxDeleteCount?: number;
}

export interface MongoTarget {
  name: string;
  collection: string;
  field: string;
  idField?: string;
  dependsOn?: string[];
  maxDeleteCount?: number;
}

export interface MySqlTarget {
  name: string;
  table: string;
  column: string;
  dependsOn?: string[];
  maxDeleteCount?: number;
}

export interface SqlServerTarget {
  name: string;
  table: string;
  column: string;
  dependsOn?: string[];
  maxDeleteCount?: number;
}

export interface RedisTarget {
  name: string;
  keyPrefix?: string;
  dependsOn?: string[];
  maxDeleteCount?: number;
  scanCount?: number;
}

export interface ApiDeleteContext {
  runId: string;
  prefix: string;
  resource: ResourceRecord;
}

export interface ApiDeleteResult {
  status: number;
  message?: string;
}

export interface ApiDeleteHandler {
  deleteById(id: string, context: ApiDeleteContext): Promise<ApiDeleteResult>;
}

export interface ApiResourceDefinition {
  strategy: 'api' | 'hybrid';
  api: ApiDeleteHandler;
  fallbackOnlyWhen?: Array<'endpoint-not-supported'>;
  postgres?: PostgresTarget;
  mysql?: MySqlTarget;
  sqlserver?: SqlServerTarget;
  mongo?: MongoTarget;
  redis?: RedisTarget;
}

export interface PostgresResourceDefinition {
  strategy: 'postgres';
  postgres: PostgresTarget;
}

export interface MongoResourceDefinition {
  strategy: 'mongo';
  mongo: MongoTarget;
}

export interface MySqlResourceDefinition {
  strategy: 'mysql';
  mysql: MySqlTarget;
}

export interface SqlServerResourceDefinition {
  strategy: 'sqlserver';
  sqlserver: SqlServerTarget;
}

export interface RedisResourceDefinition {
  strategy: 'redis';
  redis: RedisTarget;
}

export type ResourceDefinition = ApiResourceDefinition | PostgresResourceDefinition | MySqlResourceDefinition | SqlServerResourceDefinition | MongoResourceDefinition | RedisResourceDefinition;

export interface PostgresPoolLike {
  connect(): Promise<PostgresClientLike>;
  end?(): Promise<void>;
}

export interface PostgresClientLike {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
  release(): void;
}

export interface MongoCollectionLike {
  countDocuments(filter: Record<string, unknown>): Promise<number>;
  deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
}

export interface MongoDatabaseLike {
  collection(name: string): MongoCollectionLike;
}

export interface MongoClientLike {
  connect(): Promise<unknown>;
  db(name: string): MongoDatabaseLike;
  close(): Promise<void>;
}

export interface MySqlPoolLike {
  getConnection(): Promise<MySqlConnectionLike>;
  end?(): Promise<void>;
}

export interface MySqlConnectionLike {
  beginTransaction(): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<[T[], unknown]>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface SqlServerRequestLike {
  input(name: string, value: unknown): SqlServerRequestLike;
  query<T = Record<string, unknown>>(sql: string): Promise<{ recordset: T[]; rowsAffected: number[] }>;
}

export interface SqlServerTransactionLike {
  begin(): Promise<void>;
  request(): SqlServerRequestLike;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface SqlServerPoolLike {
  transaction(): SqlServerTransactionLike;
  close?(): Promise<void>;
}

export interface RedisClientLike {
  scanIterator(options?: { MATCH?: string; COUNT?: number }): AsyncIterable<string>;
  unlink(...keys: string[]): Promise<number>;
  quit?(): Promise<void>;
}

export interface DatabaseGuardConfig {
  databaseName: string;
  host?: string;
  connectionString?: string;
  allowedDatabaseNames?: string[];
  productionHostnames?: string[];
}

export interface TestDataSweeperConfig {
  cleanupEnabled: boolean;
  environment: string;
  allowedEnvironments: string[];
  dataDirectory: string;
  tenant?: string;
  postgres?: DatabaseGuardConfig & { pool?: PostgresPoolLike; connectionString?: string; targets: PostgresTarget[] };
  mysql?: DatabaseGuardConfig & { pool?: MySqlPoolLike; connectionString?: string; targets: MySqlTarget[] };
  sqlserver?: DatabaseGuardConfig & { pool?: SqlServerPoolLike; connectionString?: string; targets: SqlServerTarget[] };
  mongo?: DatabaseGuardConfig & { client?: MongoClientLike; connectionString?: string; targets: MongoTarget[] };
  redis?: DatabaseGuardConfig & { client?: RedisClientLike; connectionString?: string; targets: RedisTarget[] };
  resources?: Record<string, ResourceDefinition>;
  logger?: Logger;
}

export interface Logger {
  info(event: string, fields: Record<string, unknown>): void;
  error(event: string, fields: Record<string, unknown>): void;
}

export interface RegistryStore {
  createManifest(manifest: RunManifest): Promise<void>;
  getManifest(runId: string): Promise<RunManifest>;
  updateManifest(runId: string, patch: Partial<RunManifest>): Promise<void>;
  addRecord(runId: string, record: ResourceRecord, workerId?: string): Promise<void>;
  getRecords(runId: string): Promise<ResourceRecord[]>;
}
