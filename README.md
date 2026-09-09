# testdata-sweeper

Fail-safe PostgreSQL, MongoDB, MySQL, MariaDB, Microsoft SQL Server, and Redis test-data cleanup for Playwright test runs.

Created and maintained by [Aslı Kanpolat](https://github.com/aslikanpolat).

## What it does

`testdata-sweeper` gives every test run a unique ownership prefix and removes only data owned by that run.

- Uses API deletion by exact ID when a supported delete endpoint exists.
- Uses allowlisted PostgreSQL, MongoDB, MySQL, MariaDB, Microsoft SQL Server, or Redis cleanup for resources without delete endpoints.
- Supports explicit hybrid API/DB cleanup strategies.
- Uses worker-safe manifests for cleanup and recovery.
- Provides dry-run output and an explicit recovery CLI.
- Refuses production environments, unsafe database targets, missing prefixes, and ambiguous deletion results.

The package never runs `TRUNCATE`, `DROP DATABASE`, collection drops, or unfiltered deletes.

## Installation

```bash
npm install testdata-sweeper @playwright/test
```

Node.js 20 or newer is required.

Provider drivers are optional peer dependencies. Install only the providers used by your project:

```bash
npm install pg mongodb
npm install mysql2
npm install mssql
npm install redis
```

## Playwright integration

```ts
// test.ts
import { expect } from '@playwright/test';
import { TestDataSweeper } from 'testdata-sweeper';
import { createPlaywrightTest } from 'testdata-sweeper/playwright';
import { postgresPool } from './database';

export const testDataSweeper = new TestDataSweeper({
  cleanupEnabled: process.env.TESTDATA_SWEEPER_CLEANUP_ENABLED === 'true',
  environment: process.env.TESTDATA_SWEEPER_ENVIRONMENT ?? 'qa',
  allowedEnvironments: ['test', 'qa', 'staging'],
  dataDirectory: 'test-artifacts',
  postgres: {
    databaseName: process.env.TEST_POSTGRES_DATABASE ?? 'qa',
    host: process.env.TEST_POSTGRES_HOST,
    pool: postgresPool,
    targets: [
      { name: 'orders', table: 'orders', column: 'order_number', maxDeleteCount: 500 },
      { name: 'customers', table: 'customers', column: 'email', maxDeleteCount: 500 }
    ]
  }
});

export const test = createPlaywrightTest(testDataSweeper);
export { expect };
```

Use the `sweeperRun` fixture to mark values created by the current test:

```ts
test('creates a customer', async ({ page, sweeperRun }) => {
  const email = sweeperRun.value('email', 'customer@example.com');

  await page.goto('/customers');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Save' }).click();
});
```

The generated value uses the following format:

```text
testdata_YYYYMMDD_randomId_customer@example.com
```

For API-created resources, store the exact ID in the run manifest:

```ts
const operationId = createOperationId();
await sweeperRun.intent({ resourceType: 'customer', operationId });

const customerId = await createCustomer(email);
await sweeperRun.track({
  resourceType: 'customer',
  operationId,
  id: customerId
});
```

## Cleanup strategies

### API cleanup

Use API cleanup when the service exposes a reliable delete endpoint:

```ts
resources: {
  customer: {
    strategy: 'api',
    api: {
      async deleteById(id) {
        const response = await client.delete(`/customers/${id}`);
        return { status: response.status };
      }
    }
  }
}
```

API cleanup is performed by exact ID. A timeout, authentication error, or server error is reported as `unresolved`; it does not automatically trigger a broad database delete.

### Direct database cleanup

Use a database strategy when a resource has no delete endpoint:

```ts
resources: {
  automationRecord: {
    strategy: 'mongo',
    mongo: {
      name: 'automationRecord',
      collection: 'automation_records',
      field: 'createdBy',
      maxDeleteCount: 1000
    }
  }
}
```

PostgreSQL targets use parameterized prefix matching. Table and column names must come from the static target allowlist:

```ts
targets: [
  { name: 'order_items', table: 'order_items', column: 'order_number' },
  {
    name: 'orders',
    table: 'orders',
    column: 'order_number',
    dependsOn: ['order_items']
  }
]
```

Child targets are deleted before parent targets inside a PostgreSQL transaction. SQL `LIKE` wildcard characters in the prefix are escaped.

MongoDB uses an escaped, start-anchored `^prefix` regular expression and `deleteMany`. The MongoDB client is closed when cleanup finishes.

MySQL and MariaDB use the `mysql2` driver, parameterized prefix matching, binary comparison, transaction boundaries, and dependency-ordered deletes:

```ts
mysql: {
  databaseName: process.env.TEST_MYSQL_DATABASE ?? 'qa',
  connectionString: process.env.TEST_MYSQL_URL,
  targets: [
    { name: 'order_items', table: 'order_items', column: 'order_number' },
    { name: 'orders', table: 'orders', column: 'order_number', dependsOn: ['order_items'] }
  ]
}
```

Microsoft SQL Server uses the `mssql` driver, parameterized requests, binary collation, explicit transactions, and dependency-ordered deletes:

```ts
sqlserver: {
  databaseName: process.env.TEST_SQLSERVER_DATABASE ?? 'qa',
  connectionString: process.env.TEST_SQLSERVER_URL,
  targets: [
    { name: 'orders', table: 'Orders', column: 'OrderNumber' }
  ]
}
```

Redis uses the official `redis` client. Cleanup is limited to `SCAN MATCH` and batched `UNLINK`; `KEYS`, `FLUSHDB`, and `FLUSHALL` are never used:

```ts
redis: {
  databaseName: 'qa',
  connectionString: process.env.TEST_REDIS_URL,
  targets: [
    { name: 'order-cache', maxDeleteCount: 1000, scanCount: 100 }
  ]
}
```

Redis cleanup is prefix-based and uses `sweeperRun.value()` in keys, for example `testdata_20260909_ab12cd34_order:123`.

### Hybrid cleanup

Use hybrid cleanup when an API may exist for some environments or resources, but a direct database fallback is required for unsupported endpoints:

```ts
resources: {
  order: {
    strategy: 'hybrid',
    api: orderApiDelete,
    postgres: {
      name: 'orders',
      table: 'orders',
      column: 'order_number',
      maxDeleteCount: 500
    },
    fallbackOnlyWhen: ['endpoint-not-supported']
  }
}
```

The DB fallback is used only for an explicit unsupported-endpoint response such as HTTP 405. It is not used as a blind fallback for timeouts, authentication errors, or HTTP 5xx responses.

## Safety guards

Cleanup requires all of the following:

- `cleanupEnabled` must be `true` (`TESTDATA_SWEEPER_CLEANUP_ENABLED=true`).
- The configured environment must be in the allowed environment list.
- Production environments and production hostnames are rejected.
- Database names must be explicitly allowed (`test`, `qa`, or `staging` by default).
- Database table, column, collection, and field names must pass identifier validation.
- Every cleanup operation must use a valid run prefix.
- A `maxDeleteCount` limit can stop unexpectedly broad matches.
- A mismatched manifest environment or database fingerprint aborts recovery.

There is no automatic orphan sweep. Old runs must be selected explicitly by run ID.

## Dry-run and recovery

Recovery is dry-run by default and requires an explicit config module:

```bash
TESTDATA_SWEEPER_CLEANUP_ENABLED=true TESTDATA_SWEEPER_ENVIRONMENT=qa \
npx testdata-sweeper cleanup \
  --config ./qa-cleaner.config.mjs \
  --run-id testdata_20260909_ab12cd34
```

Execute deletion only with `--execute`:

```bash
TESTDATA_SWEEPER_CLEANUP_ENABLED=true TESTDATA_SWEEPER_ENVIRONMENT=qa \
npx testdata-sweeper cleanup \
  --config ./qa-cleaner.config.mjs \
  --run-id testdata_20260909_ab12cd34 \
  --execute
```

The config module must export a `TestDataSweeperConfig` as its default export or as `config`.

## Global teardown

For an explicit current-run safety net, export `createGlobalTeardown` from `testdata-sweeper/teardown` in the Playwright configuration:

```ts
import { createGlobalTeardown } from 'testdata-sweeper/teardown';
import { testDataSweeper } from './test';

export default {
  globalTeardown: createGlobalTeardown(testDataSweeper)
};
```

The teardown reads `TESTDATA_SWEEPER_RUN_ID` and only cleans that explicitly selected run.

## Development

```bash
npm install
npm run typecheck
npm test
npm run lint
npm run build
npm run check
npm pack --dry-run
```

The published package contains compiled output, TypeScript source, README, license, and contribution/security documentation.

## Publishing to npm

The package is configured for public npm publishing and uses the GitHub repository:

```text
https://github.com/aslikanpolat/testdata-sweeper
```

Before the first release, authenticate with npm and run:

```bash
npm login
npm publish --access public
```

After the first bootstrap publish, the GitHub Actions release workflow can be used for subsequent versioned releases. Configure the repository’s `NPM_TOKEN` secret before running it.

## License

Apache-2.0. See [LICENSE](./LICENSE).
