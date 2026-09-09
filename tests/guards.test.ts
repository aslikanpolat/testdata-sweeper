import { describe, expect, it } from 'vitest';
import { assertCleanupAllowed, assertSafeIdentifier } from '../src/guards.js';

const base = { cleanupEnabled: true, environment: 'qa', allowedEnvironments: ['qa'], dataDirectory: '/tmp/test-artifacts' };

describe('cleanup guards', () => {
  it('rejects disabled cleanup and production hosts', () => {
    expect(() => assertCleanupAllowed({ ...base, cleanupEnabled: false })).toThrow(/disabled/);
    expect(() => assertCleanupAllowed({ ...base, postgres: { databaseName: 'qa', host: 'production-db', targets: [] } })).toThrow(/production hostname/);
    expect(() => assertCleanupAllowed({ ...base, postgres: { databaseName: 'qa', connectionString: 'postgres://user:secret@production-db:5432/qa', targets: [] } })).toThrow(/production hostname/);
  });

  it('rejects databases outside the allowlist and unsafe identifiers', () => {
    expect(() => assertCleanupAllowed({ ...base, postgres: { databaseName: 'prod', targets: [] } })).toThrow(/allowed database/);
    expect(() => assertCleanupAllowed({ ...base, redis: { databaseName: 'prod', targets: [] } })).toThrow(/allowed database/);
    expect(() => assertSafeIdentifier('orders; DROP TABLE users', 'table')).toThrow();
  });

  it('rejects a production host even when a separate host override is supplied', () => {
    expect(() => assertCleanupAllowed({
      ...base,
      postgres: {
        databaseName: 'qa',
        host: 'qa-db',
        connectionString: 'postgres://user:secret@production-db:5432/qa',
        targets: []
      }
    })).toThrow(/production hostname/);
  });
});
