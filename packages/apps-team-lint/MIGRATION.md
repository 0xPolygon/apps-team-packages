# Migration Guide

Each section covers a single version jump. Follow them in order if you are
upgrading across multiple versions.

| From | To | Section |
| ---- | -- | ------- |
| 1.x  | 2.0 | [1.x → 2.0](#1x--20) |
| 0.x  | 1.0 | [0.x → 1.0](#0x--10) |

Feature adoption (non-breaking): [Adopting `astro()`](#adopting-astro).

---

## Adopting `astro()`

> Shipped in the minor release that introduces the `/astro` subpath — the exact
> version is minted by changesets at release time.

`@polygonlabs/apps-team-lint/astro` is a new, additive subpath export — nothing
changes for repos without `.astro` files, and no upgrade step is required to
keep using `recommended()`/`typescript()`/`frontend()`.

If you previously wired `eslint-plugin-astro` into your config by hand (a common
stopgap before this export existed), switch to `astro()` and delete the manual
plumbing it now owns — the Astro parser/processor, the TypeScript parser for the
frontmatter, browser globals for the inline `<script>` virtual files
(`**/*.astro/*.{js,ts}`), and the generated `.astro/**` ignore:

```diff
 // eslint.config.js
 import { defineConfig } from 'eslint/config';
-import eslintPluginAstro from 'eslint-plugin-astro';
 import globals from 'globals';

 import { recommended, typescript } from '@polygonlabs/apps-team-lint';
+import { astro } from '@polygonlabs/apps-team-lint/astro';

 export default defineConfig([
   ...recommended({ globals: 'node' }),
   ...typescript(),
-  ...eslintPluginAstro.configs.recommended,
+  ...astro(),

-  // Browser globals for client code: inline <script> blocks AND the
-  // standalone client modules they import.
+  // astro() sets browser globals for inline <script> blocks itself. A
+  // standalone client module imported by a <script> (e.g. src/scripts/app.ts)
+  // is an ordinary file, NOT an Astro virtual — so it still needs browser
+  // globals here. Keep this block, just drop the **/*.astro/*.{js,ts} glob
+  // that astro() now owns.
   {
-    files: ['src/scripts/**/*.{js,ts}', '**/*.astro/*.{js,ts}'],
+    files: ['src/scripts/**/*.{js,ts}'],
     languageOptions: { globals: { ...globals.browser } },
   },

   {
-    ignores: ['dist/**', '.astro/**'],
+    ignores: ['dist/**'],
   },
 ]);
```

Then remove `eslint-plugin-astro` (and `eslint-plugin-jsx-a11y`, if you added
it) from your `devDependencies` — both are provided transitively by this
package. Keep the `globals` import if you still have a browser-globals block for
standalone client modules (above); drop it only if you have none.

Notes when adopting:

- **Accessibility (jsx-a11y recommended) is on by default.** Expect new a11y
  findings on existing templates; fix them, or pass `astro({ a11y: false })` for
  genuinely internal tooling.
- **`astro/no-set-html-directive` is enforced as an error.** `astro/no-unsafe-inline-scripts`
  is deliberately *not* enabled — see the [README](./README.md#a-deliberate-omission).
- **Client `<script>` blocks lint as TypeScript** via the `client-side-ts`
  processor — Astro's first-class inline pattern is supported. Type-*aware*
  rules don't run inside `<script>` or `.astro` files (those virtual files
  aren't in a tsconfig project); `astro check` covers type errors there.
- **Trialing this from a worktree before release?** Consume it with `link:`,
  not `file:` — see [Testing an unpublished build](./README.md#testing-an-unpublished-build).

---

## 1.x → 2.0

### Breaking: `markdownlint` and `commitlint` are now functions

Both were previously plain config objects. Call them to get the config:

```diff
 // .markdownlint-cli2.mjs
 import { markdownlint } from '@polygonlabs/apps-team-lint/markdownlint';

-export default markdownlint;
+export default markdownlint();
```

```diff
 // commitlint.config.js
 import { commitlint } from '@polygonlabs/apps-team-lint/commitlint';

-export default commitlint;
+export default commitlint();
```

`markdownlint()` accepts optional `config` and `ignores` overrides — see the
README for details.

### Breaking: `markdownlint` and `commitlint` removed from the main entry point

If you imported either from `@polygonlabs/apps-team-lint` directly rather than
the subpath, update the import:

```diff
-import { markdownlint } from '@polygonlabs/apps-team-lint';
+import { markdownlint } from '@polygonlabs/apps-team-lint/markdownlint';

-import { commitlint } from '@polygonlabs/apps-team-lint';
+import { commitlint } from '@polygonlabs/apps-team-lint/commitlint';
```

Imports from `@polygonlabs/apps-team-lint` for ESLint functions (`recommended`,
`typescript`, `frontend`) are unchanged.

---

## 0.x → 1.0

### Breaking: Dependencies

**`eslint` must be `^10.0.0`.**

Update your root `package.json`:

```diff
-    "eslint": "^9.x.x",
+    "eslint": "^10.0.0",
```

Run `pnpm install` to pull the new version. ESLint v10 raises the minimum
Node.js engine to `^20.19.0 || ^22.13.0 || >=24` — ensure your `.nvmrc`
and CI use a supported version.

### Breaking: API changes

#### `javascript()` removed

`javascript()` only ever set globals on `.js` files. That responsibility
moves to `recommended()`, which now accepts a `globals` option that applies
to all code files uniformly.

```diff
-import { recommended, javascript, typescript } from '@polygonlabs/apps-team-lint';
+import { recommended, typescript } from '@polygonlabs/apps-team-lint';

 export default [
-  ...recommended(),
-  ...javascript({ globals: 'node' }),
-  ...typescript({ globals: 'node', tsconfigRootDir: import.meta.dirname }),
+  ...recommended({ globals: 'node' }),
+  ...typescript(),                      // single-package repo: no options needed
 ];
```

For a **monorepo per-package config**, `tsconfigRootDir` is still required
(see [Per-package `eslint.config.js` in monorepos](#per-package-eslintconfigjs-in-monorepos)):

```diff
-  ...typescript({ globals: 'node', tsconfigRootDir: import.meta.dirname }),
+  ...typescript({ tsconfigRootDir: import.meta.dirname }),
```

#### `typescript()` `globals` option removed

`globals` moves to `recommended({ globals })`. `tsconfigRootDir` is kept as
an optional parameter — it is still required in monorepo per-package configs
(see below).

```diff
-  ...typescript({ globals: 'node', tsconfigRootDir: import.meta.dirname }),
+  ...recommended({ globals: 'node' }),
+  ...typescript({ tsconfigRootDir: import.meta.dirname }),
```

#### `recommended()` gains a `globals` option

Pass `'node'`, `'browser'`, or a custom object. Globals are applied to all
code files (`**/*.{ts,tsx,js,jsx,mjs,cjs}`).

```js
...recommended({ globals: 'node' })    // Node.js globals
...recommended({ globals: 'browser' }) // Browser globals
...recommended({ globals: { MyGlobal: true } }) // Custom
```

#### `frontend()` no longer sets browser globals

`frontend()` now only provides the `.tsx` default-export exemption (and
future React/JSX-specific rules). Browser globals must be set explicitly:

```diff
 export default [
-  ...recommended(),
-  ...typescript(),
+  ...recommended({ globals: 'browser' }),
+  ...typescript(),
   ...frontend(),
 ];
```

---

### Recommended: Adopt ESLint v10 patterns

These changes are not required for the upgrade but are strongly recommended.
They take full advantage of ESLint v10's per-file config discovery.

#### Use `defineConfig`

Wrap your config array with `defineConfig` from `eslint/config` for
type-safe flat config authoring:

```js
import { defineConfig } from 'eslint/config';

import { recommended, typescript } from '@polygonlabs/apps-team-lint';

export default defineConfig([
  ...recommended({ globals: 'node' }),
  ...typescript(),
  { ignores: ['.claude/**'] },
]);
```

#### Per-package `eslint.config.js` in monorepos

In a pnpm monorepo, give each workspace package its own `eslint.config.js`
instead of using a single root config with path-based `files` overrides.
ESLint v10 walks up from each source file to find the nearest config —
packages with their own config use it automatically.

**`tsconfigRootDir` is required in every per-package config.** When ESLint
runs from the repository root (`eslint .`) and loads multiple per-package
`eslint.config.js` files in the same process, `typescript-eslint` detects
multiple candidate directories and errors unless each config explicitly
declares its own root. Always pass `tsconfigRootDir: import.meta.dirname`.

**Node.js package** (`packages/service/eslint.config.js`):

```js
import { defineConfig } from 'eslint/config';

import { recommended, typescript } from '@polygonlabs/apps-team-lint';

export default defineConfig([
  ...recommended({ globals: 'node' }),
  ...typescript({ tsconfigRootDir: import.meta.dirname }),
]);
```

**Frontend package** (`packages/example-frontend/eslint.config.js`):

```js
import { defineConfig } from 'eslint/config';

import { frontend, recommended, typescript } from '@polygonlabs/apps-team-lint';

export default defineConfig([
  ...recommended({ globals: 'browser' }),
  ...typescript({ tsconfigRootDir: import.meta.dirname }),
  ...frontend(),
]);
```

**Root `eslint.config.js`** (thin safety net — lints root-level config files
and catches packages that are missing their own config; `tsconfigRootDir` not
required here since only one config is active at the root level):

```js
import { defineConfig } from 'eslint/config';

import { recommended, typescript } from '@polygonlabs/apps-team-lint';

export default defineConfig([
  ...recommended({ globals: 'node' }),
  ...typescript(),
  { ignores: ['.claude/**'] },
]);
```

#### Root lint script

With per-package configs, a single `eslint .` from the repo root is all you
need. ESLint v10's per-file discovery uses each package's own config for
package files, and the root config for everything else.

```diff
-"lint": "pnpm -r run lint",
+"lint": "eslint .",
```

Each workspace package should still have its own `"lint": "eslint ."` script
for running lint in isolation during development.

#### TypeScript project references

For `projectService: true` to resolve cross-package TypeScript imports
correctly, the root `tsconfig.json` must reference each workspace package:

```json
{
  "files": [],
  "references": [
    { "path": "packages/schemas" },
    { "path": "packages/service" },
    { "path": "packages/client" }
  ]
}
```

Each package keeps its own `tsconfig.json`. No `tsconfigRootDir` needed.

---

*Future migrations will be documented here as new major versions are released.*
