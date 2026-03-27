# Changelog

## 2.0.0

### Major Changes

- f5938b5: ## Breaking changes

  **`markdownlint` and `commitlint` are now functions.** Call them to get the config:

  ```diff
  -export default markdownlint;
  +export default markdownlint();

  -export default commitlint;
  +export default commitlint();
  ```

  **`markdownlint` and `commitlint` removed from the main entry point.** Import
  from the subpath instead:

  ```diff
  -import { markdownlint } from '@polygonlabs/apps-team-lint';
  +import { markdownlint } from '@polygonlabs/apps-team-lint/markdownlint';

  -import { commitlint } from '@polygonlabs/apps-team-lint';
  +import { commitlint } from '@polygonlabs/apps-team-lint/commitlint';
  ```

  ## New

  **`markdownlint()` accepts `config` and `ignores` overrides.** `ignores`
  replaces the base ignore list — import `baseIgnores` to compose with it:

  ```js
  import { baseIgnores, markdownlint } from '@polygonlabs/apps-team-lint/markdownlint';

  markdownlint({ ignores: [...baseIgnores, '**/generated/**'] });
  markdownlint({ config: { MD013: { line_length: 120 } } });
  ```

  The `config` parameter is typed as `Configuration` from `markdownlint`.

  **`baseIgnores` is now a named export** from
  `@polygonlabs/apps-team-lint/markdownlint`.

  **`CHANGELOG.md` excluded from linting.** Changelog files are auto-generated
  by changesets — the generated structure reliably triggers MD022 and MD024
  violations that `--fix` cannot resolve.

### Patch Changes

- a7c5dfb: `@polygonlabs/apps-team-lint` has moved to a new monorepo. The package name, version, and public API are unchanged — no code changes required.

## 1.0.0

### Major Changes

- df9cb08: ## Dependencies
  - Bump `eslint` peer dependency from `^9.0.0` to `^10.0.0`
  - Pin `eslint-plugin-import-x` to `^4.16.2` — minimum version with ESLint v10
    peer support (fixes runtime crash in `no-default-export` rule on v10)

  ## API changes

  **`javascript()` removed.** Use `recommended({ globals: 'node' })` instead.

  **`typescript(options?)`** — `globals` option removed; `tsconfigRootDir` option
  kept and now the sole option:

  ```diff
  - ...javascript({ globals: 'node' }),
  - ...typescript({ globals: 'node', tsconfigRootDir: import.meta.dirname }),
  + ...recommended({ globals: 'node' }),
  + ...typescript({ tsconfigRootDir: import.meta.dirname }),
  ```

  - **`globals`** — moved to `recommended({ globals })`, applied to all code
    files uniformly.
  - **`tsconfigRootDir`** — kept. Required in monorepo per-package configs; omit
    for single-package repos. When `eslint .` runs from the repo root across
    multiple packages, `typescript-eslint` detects multiple candidate directories
    and errors without this explicit declaration.

  **`recommended(options?)`** — gains `{ globals?: 'node' | 'browser' | Record<string, boolean> }`.

  **`frontend()`** — browser globals removed internally. Set browser globals via
  `recommended({ globals: 'browser' })` alongside it. `frontend()` now only
  provides the `.tsx` default-export exemption.

  See [MIGRATION.md](./MIGRATION.md) for the full migration guide.

## 0.2.0

### Minor Changes

- 47d0cc1: Add `release` as a valid conventional commit type. Extends `@commitlint/config-conventional`'s `type-enum` rule and interactive `prompt` configuration so that `release: version packages` (used by the changesets release pipeline) passes commitlint validation in all team repositories.

## 0.1.1

### Fixed

- Use `resolver-next` with `createTypeScriptImportResolver()` instead of
  the string-based `'import-x/resolver': { typescript: true }` config.
  This resolves the `eslint-import-resolver-typescript` module inside
  `@polygonlabs/apps-team-lint` (where it is a declared dependency)
  rather than relying on the consumer's project root to find it.
  Consumers no longer need `eslint-import-resolver-typescript` as a
  direct devDependency.

## 0.1.0

Initial release. Composable ESLint, commitlint, and markdownlint
configurations for the Polygon Apps Team.
