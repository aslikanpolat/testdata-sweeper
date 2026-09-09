# Contributing

Thank you for contributing to `testdata-sweeper`.

## Development setup

```bash
npm install
npm run check
```

Pull requests should include tests for behavior changes and should not commit generated `dist/` or dependency directories.

## Safety expectations

Cleanup changes must preserve the production guard, target allowlists, prefix requirement, dry-run behavior, and explicit recovery boundaries. Never add an unscoped delete, truncate, database drop, or collection drop.
