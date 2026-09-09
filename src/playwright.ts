import { test as base, type TestInfo } from '@playwright/test';
import type { TestDataSweeper } from './cleaner.js';
import type { RunContext } from './run.js';

export function createPlaywrightTest(cleaner: TestDataSweeper) {
  return base.extend<{ sweeperRun: RunContext }>({
    sweeperRun: [async ({}, use, testInfo: TestInfo) => {
      const run = await cleaner.start();
      try {
        await use(run);
      } finally {
        try {
          await cleaner.cleanupRun(run.runId, { execute: true });
        } catch (error) {
          testInfo.attachments.push({ name: 'testdata-sweeper-cleanup-error', contentType: 'text/plain', body: Buffer.from(error instanceof Error ? error.stack ?? error.message : String(error)) });
          throw error;
        }
      }
    }, { auto: true }]
  });
}
