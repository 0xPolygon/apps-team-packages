# apps-team-packages

Monorepo for shared packages used across Polygon Apps Team services and frontends. Rather than
each service vendoring its own copy of common utilities — or maintaining a scatter of single-package
repos with duplicated tooling — everything lives here with unified versioning, CI, and release
management.

All packages are published to npm under the `@polygonlabs` scope and versioned independently
via changesets.

## Packages

| Package | Version | Description |
| ------- | ------- | ----------- |
| [@polygonlabs/apps-team-lint](packages/apps-team-lint) | [![npm](https://img.shields.io/npm/v/@polygonlabs/apps-team-lint)](https://www.npmjs.com/package/@polygonlabs/apps-team-lint) | Shared ESLint, markdownlint, and commitlint configurations |
| [@polygonlabs/express](packages/express) | [![npm](https://img.shields.io/npm/v/@polygonlabs/express)](https://www.npmjs.com/package/@polygonlabs/express) | Request-scoped logger middleware (via `AsyncLocalStorage`), uniform 404 handler, and global error handler that consumes the logger's ethers fetch-error sanitiser for response bodies |
| [@polygonlabs/logger](packages/logger) | [![npm](https://img.shields.io/npm/v/@polygonlabs/logger)](https://www.npmjs.com/package/@polygonlabs/logger) | Pino-based logger with Sentry integration, configured for Datadog ingestion; pino `err` serializer sanitises ethers v5/v6 fetch-error tokens across the cause chain |
| [@polygonlabs/verror](packages/verror) | [![npm](https://img.shields.io/npm/v/@polygonlabs/verror)](https://www.npmjs.com/package/@polygonlabs/verror) | TypeScript-first VError-inspired error handling with cause chains and HTTP error classes |

Each package has its own `README.md`, `package.json`, and changelog.

## Development

```bash
pnpm install          # install all dependencies
pnpm run lint         # ESLint + markdownlint + typecheck + prettier check
pnpm run format       # auto-fix all of the above
pnpm run typecheck    # TypeScript across all packages
pnpm run test         # run tests across all packages
```

To work on a specific package:

```bash
pnpm --filter <package-name> run <script>
```

## Adding a New Package

1. Create `packages/<name>/` — at minimum: `package.json`, `tsconfig.json`,
   `tsconfig.build.json`, `eslint.config.js`
2. Add a `references` entry to the root `tsconfig.json` pointing at the new package
3. Pass `tsconfigRootDir: import.meta.dirname` to `typescript()` in the package's
   `eslint.config.js` — without this, `typescript-eslint` cannot resolve the correct
   tsconfig when ESLint runs from the repo root
4. Run `pnpm install` from the repo root to wire up the workspace

## Releases

This repo uses [changesets](https://github.com/changesets/changesets). Every PR that touches
package code needs a changeset:

```bash
pnpm exec changeset add          # code or behaviour changes
pnpm exec changeset add --empty  # CI, docs, or tooling-only changes
```

Merging to `main` triggers the release pipeline: the bot opens a "Release / Deploy" PR
aggregating all pending changesets. Merging that PR publishes changed packages to npm and
creates version tags.
