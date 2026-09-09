import type { TestDataSweeper } from './cleaner.js';

export function createGlobalTeardown(cleaner: TestDataSweeper, runIdProvider: () => string | undefined = () => process.env.TESTDATA_SWEEPER_RUN_ID) {
  return async (): Promise<void> => {
    const runId = runIdProvider();
    if (!runId) return;
    await cleaner.cleanupRun(runId, { execute: true });
  };
}
