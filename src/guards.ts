import type { DatabaseGuardConfig, TestDataSweeperConfig } from './types.js';

export class CleanupSafetyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CleanupSafetyError';
  }
}

export function assertSafeIdentifier(identifier: string, kind: 'table' | 'column' | 'collection'): void {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(identifier)) {
    throw new CleanupSafetyError(`Unsafe ${kind} identifier: ${identifier}`);
  }
}

function assertDatabaseGuard(kind: string, config: DatabaseGuardConfig): void {
  if (!config.databaseName.trim()) {
    throw new CleanupSafetyError(`${kind} database name is required.`);
  }

  const allowedNames = config.allowedDatabaseNames ?? ['test', 'qa', 'staging'];
  if (!allowedNames.some((name) => name.toLowerCase() === config.databaseName.toLowerCase())) {
    throw new CleanupSafetyError(`${kind} database is not in the allowed database-name list.`);
  }

  const blockedHosts = config.productionHostnames ?? ['prod', 'production'];
  const connectionHosts = extractConnectionHosts(config.connectionString);
  if (config.connectionString && !config.host && connectionHosts.length === 0) {
    throw new CleanupSafetyError(`${kind} connection string does not expose a recognizable host.`);
  }
  const hosts = [config.host, ...connectionHosts].filter((host): host is string => Boolean(host)).map((host) => host.toLowerCase());
  if (blockedHosts.some((blocked) => hosts.some((host) => host.includes(blocked.toLowerCase())))) {
    throw new CleanupSafetyError(`${kind} production hostname is rejected.`);
  }
}

function extractConnectionHosts(connectionString?: string): string[] {
  if (!connectionString) return [];
  try {
    const url = new URL(connectionString);
    return url.host ? [url.host] : [];
  } catch {
    const match = connectionString.match(/(?:^|;)\s*(?:server|data source|address|addr|network address)\s*=\s*([^;]+)/i);
    if (!match?.[1]) return [];
    return [match[1].trim().replace(/^tcp:/i, '')];
  }
}

export function databaseFingerprint(provider: string, config: DatabaseGuardConfig): string {
  const connectionHosts = extractConnectionHosts(config.connectionString);
  const hosts = [config.host, ...connectionHosts].filter((host): host is string => Boolean(host)).map((host) => host.toLowerCase()).sort();
  return `${provider}:${config.databaseName.toLowerCase()}:${hosts.join('|') || 'unspecified'}`;
}

export function assertCleanupAllowed(config: TestDataSweeperConfig): void {
  if (config.cleanupEnabled !== true) {
    throw new CleanupSafetyError('Cleanup is disabled. Set TESTDATA_SWEEPER_CLEANUP_ENABLED=true explicitly.');
  }

  if (!config.allowedEnvironments.some((environment) => environment.toLowerCase() === config.environment.toLowerCase())) {
    throw new CleanupSafetyError(`Environment ${config.environment} is not allowed for cleanup.`);
  }

  if (config.environment.toLowerCase() === 'production') {
    throw new CleanupSafetyError('Cleanup is permanently disabled in production.');
  }

  if (config.postgres) assertDatabaseGuard('PostgreSQL', config.postgres);
  if (config.mysql) assertDatabaseGuard('MySQL', config.mysql);
  if (config.sqlserver) assertDatabaseGuard('SQL Server', config.sqlserver);
  if (config.mongo) assertDatabaseGuard('MongoDB', config.mongo);
  if (config.redis) assertDatabaseGuard('Redis', config.redis);
}
