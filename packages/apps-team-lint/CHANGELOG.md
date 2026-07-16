# Changelog

## 2.2.2

### Patch Changes

- [#73](https://github.com/0xPolygon/apps-team-packages/pull/73) [`006cf08`](https://github.com/0xPolygon/apps-team-packages/commit/006cf081e794bb156cee0f37fabc450c5b03e7c5) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Ship the LICENSE file inside the published npm package

  The previous release added the Apache-2.0 license at the repo root and
  declared it in package.json, but npm only auto-includes a LICENSE file
  in the packed tarball when it lives in the same directory as the
  package's own package.json. The license metadata was correct but the
  actual license text was missing from the published package — this adds
  it.

## 2.2.1

### Patch Changes

- [#71](https://github.com/0xPolygon/apps-team-packages/pull/71) [`aa81b1a`](https://github.com/0xPolygon/apps-team-packages/commit/aa81b1a73e0b4711d195c12e12120f5f67191305) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Add Apache-2.0 license: the package now declares `"license": "Apache-2.0"` in its `package.json`, and the repository carries the full Apache License 2.0 text. Previously no license was declared.

## 2.2.0

### Minor Changes

- 9db9fd9: Add first-class Astro support via a new `astro()` ESLint config, available from the `@polygonlabs/apps-team-lint/astro` subpath.

  Astro lives on its own subpath so repos without `.astro` files don't load the Astro toolchain. Compose it after `recommended()` and `typescript()`:

  ```js
  import { recommended, typescript } from '@polygonlabs/apps-team-lint';
  import { astro } from '@polygonlabs/apps-team-lint/astro';

  export default defineConfig([
    ...recommended({ globals: 'browser' }),
    ...typescript(),
    ...astro()
  ]);
  ```

  `astro()` builds on `eslint-plugin-astro`'s recommended config (Astro parser, the `<script>`-extracting processor, and per-region globals) and adds:
  - the `client-side-ts` processor, so client `<script>` blocks lint as TypeScript — Astro's first-class inline pattern is fully supported;
  - the TypeScript parser for the frontmatter, so typed frontmatter (`interface Props`, `const x: T`) parses instead of erroring;
  - the team's import-sorting, `import-x/no-duplicates`, and `no-param-reassign` rules on the `.astro` frontmatter;
  - `astro/no-set-html-directive` as a security error;
  - the jsx-a11y **recommended** accessibility ruleset, **on by default** — pass `astro({ a11y: false })` to disable it for internal tooling.

  `eslint-plugin-astro` and `eslint-plugin-jsx-a11y` are provided transitively, so you don't install them yourself.

  `astro/no-unsafe-inline-scripts` is deliberately not enabled — it bans Astro's idiomatic inline `<script>import>` pattern, and strict CSP is an app-level policy. Type-aware rules don't run inside `<script>` blocks (that's `astro check`'s job). See the README and MIGRATION guide for adoption details.

## 2.1.0

### Minor Changes

- 50edeeb: Add `polygon/no-discarded-typed-registry-chain` rule to the `typescript()` preset.

  Catches the partial-discard case in `@polygonlabs/openapi-registry`'s chainable API that the type-level `OperationsOf<F>` brand can't detect: `r.registerPath({…});` (or `.registerSecurityScheme(…)`, or `.with(…)`) in expression-statement position on a `TypedRegistry` receiver still mutates the underlying registry at runtime, but the type-level narrow is dropped — downstream consumers reading `OperationsOf<typeof buildRegistry>` see a manifest with that operation missing, even though the OpenAPI spec contains it. The rule is type-aware (uses `parserServices` from the existing `projectService: true` setup) so it only fires on `TypedRegistry` receivers — same-named methods on unrelated classes are not flagged.

  The rule is enabled at `'error'` severity in the `typescript()` preset, so consuming repos pick it up automatically when they update.

  To opt out for a deliberate test fixture (e.g. demonstrating the failure mode), add a scoped `eslint-disable polygon/no-discarded-typed-registry-chain` directive with a `--` comment explaining why.

## 2.0.2

### Patch Changes

- 04e690a: Underscore-prefixed variables and parameters no longer trigger the unused-vars error.

  Overrides `@typescript-eslint/no-unused-vars` from `tseslint.configs.recommended` to add
  `argsIgnorePattern` and `varsIgnorePattern` matching `/^_/`, restoring the conventional
  behaviour where a leading underscore signals an intentionally unused name — most commonly
  needed for the mandatory fourth parameter in Express error-handling middleware.

## 2.0.1

### Patch Changes

- 820c80a: `MIGRATION.md` is now included in the published npm bundle.

  Previously, `MIGRATION.md` was present in the repository but absent from the `files`
  allowlist in `package.json`, so it was silently dropped when packages were published
  to the registry. Consumers who installed a package and looked for migration guidance
  would find no file. Adding `"MIGRATION.md"` to `files` ensures it ships alongside
  `dist/` in every release.

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
