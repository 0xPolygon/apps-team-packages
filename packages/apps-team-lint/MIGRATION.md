# Migration Guide

Each section covers a single version jump. Follow them in order if you are
upgrading across multiple versions.

| From | To | Section |
| ---- | -- | ------- |
| 0.x  | 1.0 | [0.x → 1.0](#0x--10) |

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
