import { randomUUID } from 'node:crypto';

export function createRunId(now = new Date(), randomId = randomUUID().replaceAll('-', '').slice(0, 8)): string {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `testdata_${date}_${randomId}`;
}

export function createPrefix(now?: Date, randomId?: string): string {
  return `${createRunId(now, randomId)}_`;
}

export function escapeLikePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, '\\$&')}%`;
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function assertRunId(runId: string): void {
  if (!/^testdata_[0-9]{8}_[A-Za-z0-9-]{4,64}$/.test(runId)) {
    throw new Error('Invalid cleanup run ID. Expected testdata_<YYYYMMDD>_<randomId>.');
  }
}

export function assertPrefix(prefix: string): void {
  if (!/^testdata_[0-9]{8}_[A-Za-z0-9-]{4,64}_$/.test(prefix)) {
    throw new Error('Invalid cleanup prefix. Expected testdata_<YYYYMMDD>_<randomId>_.');
  }
}
