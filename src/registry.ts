import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { assertPrefix, assertRunId } from './prefix.js';
import type { RegistryStore, ResourceRecord, RunManifest } from './types.js';

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, 'utf8');
  await rename(temporaryPath, path);
}

export class FileRegistry implements RegistryStore {
  private readonly rootDirectory: string;

  public constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory);
  }

  private runDirectory(runId: string): string {
    assertRunId(runId);
    const directory = resolve(this.rootDirectory, runId);
    const relativeDirectory = relative(this.rootDirectory, directory);
    if (!relativeDirectory || relativeDirectory.startsWith('..') || isAbsolute(relativeDirectory)) {
      throw new Error('Run ID resolves outside the configured data directory.');
    }
    return directory;
  }

  private manifestPath(runId: string): string {
    return join(this.runDirectory(runId), 'manifest.json');
  }

  public async createManifest(manifest: RunManifest): Promise<void> {
    assertRunId(manifest.runId);
    assertPrefix(manifest.prefix);
    if (manifest.prefix.slice(0, -1) !== manifest.runId) {
      throw new Error('Manifest run ID and prefix do not match.');
    }
    await mkdir(join(this.runDirectory(manifest.runId), 'records'), { recursive: true });
    try {
      await access(this.manifestPath(manifest.runId));
      throw new Error(`A manifest already exists for run ${manifest.runId}.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await atomicWrite(this.manifestPath(manifest.runId), JSON.stringify(manifest, null, 2));
  }

  public async getManifest(runId: string): Promise<RunManifest> {
    const raw = await readFile(this.manifestPath(runId), 'utf8');
    return JSON.parse(raw) as RunManifest;
  }

  public async updateManifest(runId: string, patch: Partial<RunManifest>): Promise<void> {
    const manifest = await this.getManifest(runId);
    const updated: RunManifest = { ...manifest, ...patch, updatedAt: new Date().toISOString() };
    await atomicWrite(this.manifestPath(runId), JSON.stringify(updated, null, 2));
  }

  public async addRecord(runId: string, record: ResourceRecord, workerId = process.env.TEST_WORKER_INDEX ?? 'main'): Promise<void> {
    const directory = join(this.runDirectory(runId), 'records');
    await mkdir(directory, { recursive: true });
    if (!/^[A-Za-z0-9_.-]+$/.test(workerId)) {
      throw new Error('Unsafe Playwright worker identifier.');
    }
    const path = join(directory, `worker-${workerId}-${randomUUID()}.json`);
    await atomicWrite(path, JSON.stringify(record, null, 2));
  }

  public async getRecords(runId: string): Promise<ResourceRecord[]> {
    const directory = join(this.runDirectory(runId), 'records');
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: ResourceRecord[] = [];
    for (const file of files.filter((name) => name.endsWith('.json'))) {
      const parsed = JSON.parse(await readFile(join(directory, file), 'utf8')) as ResourceRecord | ResourceRecord[];
      records.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }
    return records;
  }
}
