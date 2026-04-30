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
| [@polygonlabs/express](packages/express) | [![npm](https://img.shields.io/npm/v/@polygonlabs/express)](https://www.npmjs.com/package/@polygonlabs/express) | Request-scoped logger middleware (via `AsyncLocalStorage`), uniform 404 handler, global error handler that consumes the logger's ethers fetch-error sanitiser for response bodies, and a `/registry` subpath that materialises a typed Express router from a `TypedRegistry` (`createRegistryRouter().auth().implement().toExpress()`) with compile-time exhaustiveness on auth handlers and operation handlers |
| [@polygonlabs/logger](packages/logger) | [![npm](https://img.shields.io/npm/v/@polygonlabs/logger)](https://www.npmjs.com/package/@polygonlabs/logger) | Pino-based logger with Sentry integration, configured for Datadog ingestion; pino `err` serializer sanitises ethers v5/v6 fetch-error tokens across the cause chain |
| [@polygonlabs/openapi-registry](packages/openapi-registry) | [![npm](https://img.shields.io/npm/v/@polygonlabs/openapi-registry)](https://www.npmjs.com/package/@polygonlabs/openapi-registry) | Type-accumulating drop-in for `@asteasolutions/zod-to-openapi`'s `OpenAPIRegistry`. Each `registerPath` / `registerSecurityScheme` narrows the registry's type via `asserts this is X`, so downstream consumers (Express request/response validation, codegen audits, gateway aggregation) read the accumulated operations and security schemes via inferred return types |
| [@polygonlabs/sync-github-releases](packages/sync-github-releases) | [![npm](https://img.shields.io/npm/v/@polygonlabs/sync-github-releases)](https://www.npmjs.com/package/@polygonlabs/sync-github-releases) | CLI that syncs GitHub Release bodies and titles from each package's `CHANGELOG.md`, byte-equal to what `changesets/action` emits natively. Recovers the GitHub Releases that are skipped when a brand-new package's first npm publish 403s under OIDC and `changesets/action` exits non-zero before the create-release step |
| [@polygonlabs/verror](packages/verror) | [![npm](https://img.shields.io/npm/v/@polygonlabs/verror)](https://www.npmjs.com/package/@polygonlabs/verror) | TypeScript-first VError-inspired error handling with cause chains and HTTP error classes |
| [@polygonlabs/wallet-kit](packages/wallet-kit) | [![npm](https://img.shields.io/npm/v/@polygonlabs/wallet-kit)](https://www.npmjs.com/package/@polygonlabs/wallet-kit) | Shared React wallet integration for Polygon frontends: Sequence Connect provider, smart-contract-wallet / Sequence-v3 detection helpers, TRM sanctions screening |
| [@polygonlabs/zod-codecs](packages/zod-codecs) | [![npm](https://img.shields.io/npm/v/@polygonlabs/zod-codecs)](https://www.npmjs.com/package/@polygonlabs/zod-codecs) | Zod v4 codecs for the wire formats JSON-on-the-wire services keep reinventing — int64 strings, unbounded big integers, decimal strings, and ISO datetimes — that decode into the right runtime type and round-trip back |
| [@polygonlabs/zod-to-openapi-heyapi](packages/zod-to-openapi-heyapi) | [![npm](https://img.shields.io/npm/v/@polygonlabs/zod-to-openapi-heyapi)](https://www.npmjs.com/package/@polygonlabs/zod-to-openapi-heyapi) | `@hey-api/openapi-ts` plugin that sources Zod schemas from a `@asteasolutions/zod-to-openapi` `OpenAPIRegistry`; emits per-status `Responses`/`Errors` types as `z.output<typeof Schema>` and per-operation `parseAsync` transformers so codec output (bigint, Date, etc.) reaches the caller |

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
4. Add a row to the [Packages](#packages) table above (kept alphabetised by package
   name) with the npm version badge and a row blurb in the same register as its
   neighbours
5. Run `pnpm install` from the repo root to wire up the workspace

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
