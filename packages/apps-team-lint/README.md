# @polygonlabs/apps-team-lint

Shared lint configurations for Polygon TypeScript repositories.

Bundles ESLint, markdownlint, and commitlint configs into a single
package so repos update by bumping one dependency version instead of
copying config files.

## Upgrading

| From | To | Guide |
| ---- | -- | ----- |
| 1.x  | 2.0 | [MIGRATION.md](./MIGRATION.md#1x--20) |
| 0.x  | 1.0 | [MIGRATION.md](./MIGRATION.md#0x--10) |

## Install

```bash
pnpm add -D @polygonlabs/apps-team-lint eslint typescript
```

`eslint` and `typescript` are peer dependencies — keep them in your repo's
devDependencies.

The main entry point (`@polygonlabs/apps-team-lint`) exports only the ESLint
config functions. Markdownlint and commitlint configs are available via explicit
subpath imports:

- `@polygonlabs/apps-team-lint/markdownlint`
- `@polygonlabs/apps-team-lint/commitlint`

The following packages are now provided transitively and
can be removed from your devDependencies:

- `eslint-config-prettier`
- `eslint-import-resolver-typescript`
- `eslint-plugin-import-x`
- `eslint-plugin-perfectionist`
- `globals`
- `typescript-eslint`
- `@commitlint/config-conventional`

### Testing an unpublished build

To consume an unpublished build of this package in another repo (e.g. to trial
a change before release), **`link:` the package directory — do not `file:` it**:

```bash
pnpm add -D "link:../path/to/apps-team-packages/packages/apps-team-lint"
```

`link:` points at the live package directory, so the exports resolve the
TypeScript source directly — no build step. `file:` instead *packs* the
directory honoring `files` (which ships only `dist/`), which is publish-shaped
and omits `src/`, so the source exports fail to resolve. Use `file:` / `pnpm
pack` only to validate the published artifact.

## ESLint

Three composable function exports from the main entry point, each returning a
flat config array. Always spread `recommended()` first. Astro projects also get
an [`astro()`](#astro-components) export from the `/astro` subpath.

### Single-package repo — Node.js

```js
// eslint.config.js
import { defineConfig } from 'eslint/config';

import { recommended, typescript } from '@polygonlabs/apps-team-lint';

export default defineConfig([
  ...recommended({ globals: 'node' }),
  ...typescript(),
]);
```

### Single-package repo — Frontend (browser globals)

```js
// eslint.config.js
import { defineConfig } from 'eslint/config';

import { frontend, recommended, typescript } from '@polygonlabs/apps-team-lint';

export default defineConfig([
  ...recommended({ globals: 'browser' }),
  ...typescript(),
  ...frontend(),
]);
```

> **Monorepo?** Each workspace package needs its own `eslint.config.js` and
> must pass `tsconfigRootDir: import.meta.dirname` to `typescript()`. See
> [Monorepo setup](#monorepo-setup) below.

### Astro components

Astro support ships as a separate subpath export —
`@polygonlabs/apps-team-lint/astro` — because most repos have no `.astro` files
and shouldn't pay to load the Astro toolchain just by importing the package.
Spread `astro()` **after** `recommended()` and `typescript()`:

```js
// eslint.config.js
import { defineConfig } from 'eslint/config';

import { recommended, typescript } from '@polygonlabs/apps-team-lint';
import { astro } from '@polygonlabs/apps-team-lint/astro';

export default defineConfig([
  ...recommended({ globals: 'browser' }),
  ...typescript(),
  ...astro(),
]);
```

`eslint-plugin-astro` and `eslint-plugin-jsx-a11y` are provided transitively —
no need to install them. `astro()` builds on `eslint-plugin-astro`'s recommended
config (the Astro parser, the `<script>`-extracting processor, and per-region
globals: Node for the build-time frontmatter, browser for client `<script>`
blocks) and adds:

- the `client-side-ts` processor, so client `<script>` blocks are linted as
  **TypeScript** — inline `<script>` (including TS) is Astro's first-class,
  bundled pattern, and the team's rules apply inside it;
- the TypeScript parser for the frontmatter, so typed frontmatter
  (`interface Props`, `const x: T = …`) parses instead of erroring;
- the team's import-sorting, `import-x/no-duplicates`, and `no-param-reassign`
  rules on the `.astro` frontmatter (which `recommended()`/`typescript()` skip,
  since their file globs match the virtual `<script>` files but not the
  `.astro` file itself);
- `astro/no-set-html-directive` as a security error;
- the jsx-a11y **recommended** accessibility ruleset.

**Accessibility is on by default.** Pass `astro({ a11y: false })` only for
genuinely internal tooling where a11y findings are noise rather than defects.
The a11y rules surface under the **`astro/jsx-a11y/*`** namespace (the plugin
re-exports jsx-a11y through its own `astro/` prefix) — grepping for a bare
`jsx-a11y/` will wrongly read as "a11y is off".

`astro()` takes no `tsconfigRootDir`. Type-*aware* rules (e.g.
`no-floating-promises`) do **not** run inside `<script>` blocks or `.astro`
files — those virtual files are not part of any tsconfig project, so type-aware
rules are disabled there. Type errors in `.astro` are `astro check`/`tsc`'s job,
not ESLint's. In a monorepo, still pass `tsconfigRootDir` to `typescript()` as
usual.

> **Expected install warning.** `eslint-plugin-jsx-a11y@6` declares an ESLint
> `^3 – ^9` peer range, so pnpm prints an unmet-peer warning on ESLint 10. It is
> harmless — the a11y rules run correctly on ESLint 10; the package simply
> hasn't widened its peer range yet (track upstream at
> <https://github.com/jsx-eslint/eslint-plugin-jsx-a11y/issues>). To silence it,
> add to the consuming repo's `package.json`:
>
> ```jsonc
> // package.json
> "pnpm": {
>   "peerDependencyRules": {
>     "allowedVersions": { "eslint-plugin-jsx-a11y>eslint": "10" }
>   }
> }
> ```

#### A deliberate omission

**`astro/no-unsafe-inline-scripts` is not enabled.** Despite its name it bans
*every* inline `<script>` without a `src` — including Astro's idiomatic
`<script>import './client.js'</script>` bundling pattern. Strict-CSP,
external-only scripts is an app-level policy a repo can opt into, not a sensible
team-wide error. Add it to your own config if your app needs it; don't add it to
this preset.

### Adding repo-specific overrides

Append additional config objects after the presets:

```js
import { defineConfig } from 'eslint/config';

import { recommended, typescript } from '@polygonlabs/apps-team-lint';

export default defineConfig([
  ...recommended({ globals: 'node' }),
  ...typescript(),
  { ignores: ['**/generated/**'] },
  {
    files: ['scripts/**/*.js'],
    rules: { 'no-console': 'off' },
  },
]);
```

### Monorepo setup

ESLint v10 discovers configs per-file, so each workspace package can have
its own `eslint.config.js`. The root config acts as a thin safety net for
root-level files and any packages missing their own config.

**Monorepo — per-package `eslint.config.js` (recommended):**

Each workspace package gets its own `eslint.config.js`. Pass
`tsconfigRootDir: import.meta.dirname` to `typescript()` — this is required
when running `eslint .` from the repo root with multiple packages.

```js
// packages/service/eslint.config.js
import { defineConfig } from 'eslint/config';

import { recommended, typescript } from '@polygonlabs/apps-team-lint';

export default defineConfig([
  ...recommended({ globals: 'node' }),
  ...typescript({ tsconfigRootDir: import.meta.dirname }),
]);
```

**Frontend package:**

```js
// packages/example-frontend/eslint.config.js
import { defineConfig } from 'eslint/config';

import { frontend, recommended, typescript } from '@polygonlabs/apps-team-lint';

export default defineConfig([
  ...recommended({ globals: 'browser' }),
  ...typescript({ tsconfigRootDir: import.meta.dirname }),
  ...frontend(),
]);
```

**Root `eslint.config.js`** (thin safety net — lints root-level files and
provides fallback for packages without their own config; no `tsconfigRootDir`
needed at the root level):

```js
import { defineConfig } from 'eslint/config';

import { recommended, typescript } from '@polygonlabs/apps-team-lint';

export default defineConfig([
  ...recommended({ globals: 'node' }),
  ...typescript(),
  { ignores: ['.claude/**'] },
]);
```

Root `package.json` lint script: `"lint": "eslint ."` — ESLint v10's
per-file config discovery means this single command uses each package's
own config automatically.

### Exports reference

| Export | Options | What it configures |
| --- | --- | --- |
| `recommended(options?)` | `{ globals?: 'node' \| 'browser' \| Record<string, boolean> }` | Global ignores, import sorting (perfectionist), import-x rules, core rules (`no-param-reassign`, etc.), default-export exemptions for config files, Prettier compatibility, environment globals |
| `typescript(options?)` | `{ tsconfigRootDir?: string }` — required in monorepo per-package configs | TS-ESLint recommended rules, type-aware linting (`projectService`), TS import resolver, `consistent-type-imports`, `no-floating-promises`, `no-explicit-any` (warn), [`polygon/no-discarded-typed-registry-chain`](#no-discarded-typed-registry-chain) |
| `frontend()` | none | `no-default-export` exemption for `.tsx` files |
| [`astro(options?)`](#astro-components) — imported from `@polygonlabs/apps-team-lint/astro` | `{ a11y?: boolean }` — accessibility ruleset, default `true` | `eslint-plugin-astro` recommended, `client-side-ts` processor (TypeScript in `<script>`), TypeScript parser + team import rules on the frontmatter, `astro/no-set-html-directive` error, jsx-a11y recommended (on by default) |

## Custom rules

The `typescript()` preset registers an internal `polygon/*` plugin
holding rules that catch failure modes specific to other
`@polygonlabs/*` packages.

### no-discarded-typed-registry-chain

Flags discarded chain returns from `@polygonlabs/openapi-registry`'s
`TypedRegistry`. The chainable API returns a registry typed with the
just-registered entry added — `r.registerPath({…});` (with the result
dropped) still mutates the underlying registry at runtime, but the
type-level narrow is lost. Downstream
`OperationsOf<typeof buildRegistry>` then under-reports operations,
even though the OpenAPI spec contains them.

The rule is type-aware (uses `parserServices` from the
`projectService: true` setup) so it only fires on real `TypedRegistry`
receivers — same-named methods on unrelated classes are not flagged.
The flagged methods are the narrow-carrying ones: `registerPath`,
`registerSecurityScheme`, and `with`. The forwarded chain methods
(`registerComponent`, `registerWebhook`, `register`,
`registerParameter`) don't carry type-level narrows, so discarding
them is safe and not flagged.

Enabled at `'error'` severity. To opt out for a deliberate fixture
that demonstrates the failure mode (e.g. an internal test pinning
runtime side-effect behaviour), add a scoped
`eslint-disable polygon/no-discarded-typed-registry-chain` directive with a `--`
comment explaining why.

```ts
// chain (idiomatic) — no flag
return r.registerPath(a).registerPath(b);

// capture (acceptable when imperative branching matters) — no flag
let r1 = r.registerPath(a);
if (cond) r1 = r1.registerPath(b);
return r1;

// silent failure — flagged
r.registerPath(a);                     // return discarded
r.registerPath(b);                     // return discarded
return r;                              // type unchanged from input
```

## Markdownlint

Use a `.markdownlint-cli2.mjs` file rather than a static `.jsonc` so the
config stays centrally managed — rule and ignore updates propagate to all
repos on the next `pnpm update`, with no manual copying required.

```js
// .markdownlint-cli2.mjs
import { markdownlint } from '@polygonlabs/apps-team-lint/markdownlint';

export default markdownlint();
```

Delete your `.markdownlint-cli2.jsonc` after adding this file.

When passed, `ignores` replaces the base ignore list entirely. Import
`baseIgnores` to compose with it:

```js
// .markdownlint-cli2.mjs
import { baseIgnores, markdownlint } from '@polygonlabs/apps-team-lint/markdownlint';

// Default — uses base ignore list as-is:
export default markdownlint();

// Add ignores:
export default markdownlint({ ignores: [...baseIgnores, '**/generated/**'] });

// Remove an ignore:
export default markdownlint({ ignores: baseIgnores.filter(i => i !== '**/CHANGELOG.md') });
```

Pass `config` to override specific rules — shallow-merged with the base, so
only the rules you specify are affected:

```js
export default markdownlint({ config: { MD013: { line_length: 120 } } });
```

### What the config enforces

All [built-in markdownlint rules](https://github.com/DavidAnson/markdownlint/blob/main/doc/Rules.md)
are enabled by default. The following rules are explicitly overridden:

| Rule | Setting | Why |
| ---- | ------- | --- |
| MD013 line-length | disabled | Long lines are unavoidable in practice — URLs, table cells, and inline code cannot be wrapped without breaking formatting or readability. |
| MD024 no-duplicate-heading | `siblings_only` | Duplicate headings are only flagged when they are direct siblings in the same section. Same-named headings in different sections (e.g. `### Parameters` in multiple API entries) are intentional and common. |
| MD041 first-line-heading | disabled | Not all markdown files should begin with a heading — preamble, front matter, or files like `MIGRATION.md` that open with prose are legitimate. |
| MD060 table-column-style | disabled | Prettier formats tables by padding columns to equal width, which produces spacing that MD060 misreads as inconsistent style. With Prettier already owning table formatting, MD060 produces false positives. |

`CHANGELOG.md` files are excluded from linting entirely. They are auto-generated
by changesets and committed by the release bot without running hooks. The generated
structure (version headings, changeset body embedded in list items) reliably triggers
MD022 and MD024 violations that `--fix` cannot resolve.

## Commitlint

```js
// commitlint.config.js
import { commitlint } from '@polygonlabs/apps-team-lint/commitlint';

export default commitlint();
```

This extends `@commitlint/config-conventional`, which is provided as a
transitive dependency — no need to install it separately.

## What stays in your repo

This package provides lint *configuration*. Your repo still needs its own:

- **`eslint`** and **`typescript`** as devDependencies (peer deps)
- **`@commitlint/cli`** (the CLI runner — the config is provided by this package)
- **`markdownlint-cli2`** (the CLI runner)
- **`prettier`** and **`.prettierrc.json`** (Prettier config is not distributed here)
- **`.husky/`** hooks
- **`.nvmrc`**
