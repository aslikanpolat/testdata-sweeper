import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileRegistry } from '../src/registry.js';

describe('FileRegistry', () => {
  it('keeps worker records in separate files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qa-cleaner-'));
    const registry = new FileRegistry(directory);
    await registry.createManifest({ schemaVersion: 1, runId: 'testdata_20260909_abc12345', prefix: 'testdata_20260909_abc12345_', environment: 'qa', databaseFingerprints: [], status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() });
    await registry.addRecord('testdata_20260909_abc12345', { resourceType: 'customer', id: '1', createdAt: new Date().toISOString(), status: 'created' }, '0');
    await registry.addRecord('testdata_20260909_abc12345', { resourceType: 'customer', id: '2', createdAt: new Date().toISOString(), status: 'created' }, '1');
    expect((await registry.getRecords('testdata_20260909_abc12345')).map((record) => record.id)).toEqual(expect.arrayContaining(['1', '2']));
  });

  it('rejects path traversal and preserves concurrent worker records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'testdata-sweeper-'));
    const registry = new FileRegistry(directory);
    const now = new Date().toISOString();
    await registry.createManifest({ schemaVersion: 1, runId: 'testdata_20260909_abc12346', prefix: 'testdata_20260909_abc12346_', environment: 'qa', databaseFingerprints: [], status: 'active', createdAt: now, updatedAt: now, heartbeatAt: now });

    await expect(registry.getManifest('..')).rejects.toThrow(/Invalid cleanup run ID/);
    await Promise.all(Array.from({ length: 20 }, (_, index) => registry.addRecord('testdata_20260909_abc12346', { resourceType: 'customer', id: String(index), createdAt: now, status: 'created' }, '0')));
    expect((await registry.getRecords('testdata_20260909_abc12346')).length).toBe(20);
  });
});
