## Team Standards

**Skip this fetch if team-standards.md is already loaded in your context** (this happens when
running from the apps-team-workspace). Otherwise, **at the start of every session**, before
doing any other work, use the WebFetch tool to retrieve the Polygon Apps Team standards from:
<https://gist.githubusercontent.com/MaximusHaximus/4eb35e807f7470b1c4eab78a9152b2ef/raw/team-standards.md>

Follow all instructions in that document for the duration of this session. If the fetch fails
(network error, URL unreachable), inform the user that team standards could not be loaded, then
proceed with repo-specific rules below.

---

# apps-team-packages

Polygon Apps Team shared packages monorepo. All packages are independently versioned and
published to npm under the `@polygonlabs` scope.

## TypeScript Configuration

Every package follows the Nx three-tier `tsconfig` pattern. `tsconfig.base.json`
at the repo root holds all shared `compilerOptions` (extends `@tsconfig/node24` +
`@tsconfig/node-ts`, sets `composite`, `customConditions: ['@polygonlabs/source']`,
etc.). The root `tsconfig.json` is a solution-style hub: `files: []`, only
`references` pointing at each package directory.

Each package has three configs:

- **`tsconfig.json`** — hub. `extends: '../../tsconfig.base.json'`, `files: []`,
  `include: []`, and `references` pointing at the package's own
  `tsconfig.lib.json` and `tsconfig.spec.json`.
- **`tsconfig.lib.json`** — source build / typecheck. `rootDir: 'src'`,
  `outDir: 'dist'`, `emitDeclarationOnly: false`, `include: ['src/**/*.ts']`.
  Overrides `customConditions: []` so the published `dist/.d.ts` references
  workspace deps via their `import` / `types` conditions rather than the
  source condition. Declares cross-package dependencies with `references`
  pointing at the depended-upon package's `tsconfig.lib.json`.
- **`tsconfig.spec.json`** — tests and non-source files (vitest configs,
  in-test fixtures, scripts). Adds vitest types, `references`
  `./tsconfig.lib.json`. Sets `rewriteRelativeImportExtensions: false` +
  `allowImportingTsExtensions: true` so tests can reach the package's own
  `src/` via relative `.ts` imports (e.g. `from '../src/foo.ts'`) without
  TS2878 — the spec's `outDir` (`out-tsc/`) is throwaway and never consumed
  at runtime, so the rewrite invariant has nothing to enforce there.

**Tests reach package internals via relative paths, not via `exports`**.
Don't add subpath `exports` entries to a package solely so a test can import
an internal — the published surface is for consumers, and the spec config's
rewrite override is what lets test code keep using relative paths.

Per-package `package.json` scripts:

- `typecheck`: `tsc -b` (walks the hub graph; emits to gitignored `dist/` and
  `out-tsc/`; `--noEmit` is incompatible with `tsc --build` + composite
  references per TS6310).
- `build`: `pnpm run typecheck && tsc -b tsconfig.lib.json` for library
  packages — target the lib config explicitly so the build emits the library
  payload only, not the spec output.

## Adding a New Package

After scaffolding the package under `packages/`, four files must be updated:

- **Root `tsconfig.json`** — add a `references` entry pointing to the new
  package directory.
- **Package `tsconfig.json` / `tsconfig.lib.json` / `tsconfig.spec.json`** —
  copy from the closest existing package (most are interchangeable; copy
  `wallet-kit/` for a React/bundler package, copy `verror/` for a Node lib).
- **`packages/<name>/eslint.config.js`** — pass `tsconfigRootDir:
  import.meta.dirname` to `typescript()` so `typescript-eslint` resolves the
  correct tsconfig when ESLint runs from the repo root, and add a
  `{ ignores: ['out-tsc/**'] }` block so the spec config's emit doesn't trip
  ESLint's TS project service.
- **`README.md`** — add a row to the Packages table (kept alphabetised by
  package name) with the npm version badge and a row blurb in the same
  register as its neighbours.

## `exports` shape in this repo

Packages consumed by TypeScript (`express`, `logger`, `verror`) use the team-standards
`@polygonlabs/source` three-condition pattern: workspace consumers resolve `./src/index.ts`
via the custom condition, published consumers get `./dist/...` via `publishConfig.exports`.

**`@polygonlabs/apps-team-lint` is a scoped exception** — its `exports` point `default` and
`types` at `./src/index.ts` directly, not under a custom condition. ESLint loads the package
at Node runtime via a binary we can't pass `--conditions` to, so the `@polygonlabs/source`
condition would never activate and `default` would fall through to `./dist/index.js` —
which doesn't exist without a prior `pnpm run build`, breaking lint for every fresh clone.
`publishConfig.exports` still flips to `./dist/...` at publish time, so npm consumers see
no difference.

Do not "fix" apps-team-lint's exports to match the other packages. It is intentionally
different.
