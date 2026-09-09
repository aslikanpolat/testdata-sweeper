#!/usr/bin/env node
import { resolve } from 'node:path';
import { TestDataSweeper } from './cleaner.js';

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] !== 'cleanup' && args[0] !== 'recover') throw new Error('Usage: testdata-sweeper cleanup --run-id <id> [--execute]');
  const runId = value(args, '--run-id');
  if (!runId) throw new Error('--run-id is required.');
  const configPath = value(args, '--config') ?? process.env.TESTDATA_SWEEPER_CONFIG;
  if (!configPath) throw new Error('--config or TESTDATA_SWEEPER_CONFIG is required. The module must export a TestDataSweeperConfig as default or config.');
  const imported = await import(resolve(configPath));
  const config = (imported.default ?? imported.config) as ConstructorParameters<typeof TestDataSweeper>[0];
  const cleaner = new TestDataSweeper({
    ...config,
    cleanupEnabled: process.env.TESTDATA_SWEEPER_CLEANUP_ENABLED === 'true' || config.cleanupEnabled,
    environment: process.env.TESTDATA_SWEEPER_ENVIRONMENT ?? config.environment,
    allowedEnvironments: config.allowedEnvironments ?? (process.env.TESTDATA_SWEEPER_ALLOWED_ENVIRONMENTS ?? 'test,qa,staging').split(','),
    dataDirectory: process.env.TESTDATA_SWEEPER_DATA_DIRECTORY ?? config.dataDirectory
  });
  const execute = args.includes('--execute');
  const results = await cleaner.cleanupRun(runId, execute ? { execute: true } : { dryRun: true });
  console.log(JSON.stringify({ runId, execute, results }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
