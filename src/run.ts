import { randomUUID } from 'node:crypto';
import { assertPrefix } from './prefix.js';
import type { RegistryStore, ResourceRecord, RunManifest } from './types.js';

export interface RunContext {
  readonly runId: string;
  readonly prefix: string;
  value<T extends string | number>(field: string, value: T): string;
  intent(resource: Omit<ResourceRecord, 'createdAt' | 'status'>): Promise<void>;
  track(resource: Omit<ResourceRecord, 'createdAt' | 'status'>): Promise<void>;
}

export async function createRunContext(registry: RegistryStore, prefix: string, environment: string, tenant?: string, databaseFingerprints: string[] = []): Promise<RunContext> {
  assertPrefix(prefix);
  const runId = prefix.slice(0, -1);
  const now = new Date().toISOString();
  const manifest: RunManifest = { schemaVersion: 1, runId, prefix, environment, ...(tenant === undefined ? {} : { tenant }), databaseFingerprints, status: 'active', createdAt: now, updatedAt: now, heartbeatAt: now };
  await registry.createManifest(manifest);
  return {
    runId,
    prefix,
    value: <T extends string | number>(_field: string, value: T) => `${prefix}${String(value)}`,
    intent: async (resource) => registry.addRecord(runId, { ...resource, createdAt: new Date().toISOString(), status: 'intent' }),
    track: async (resource) => registry.addRecord(runId, { ...resource, createdAt: new Date().toISOString(), status: 'created' })
  };
}

export function createOperationId(): string {
  return randomUUID();
}
