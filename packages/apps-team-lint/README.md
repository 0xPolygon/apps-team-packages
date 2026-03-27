# @polygonlabs/apps-team-lint

Shared lint configurations for Polygon TypeScript repositories.

Bundles ESLint, markdownlint, and commitlint configs into a single
package so repos update by bumping one dependency version instead of
copying config files.

## Upgrading

| From | To | Guide |
| ---- | -- | ----- |
| 0.x  | 1.0 | [MIGRATION.md](./MIGRATION.md#0x--10) |

## Install

```bash
pnpm add -D @polygonlabs/apps-team-lint eslint typescript
```

`eslint` and `typescript` are peer dependencies — keep them in your repo's
devDependencies. The following packages are now provided transitively and
can be removed from your devDependencies:

- `eslint-config-prettier`
- `eslint-import-resolver-typescript`
- `eslint-plugin-import-x`
- `eslint-plugin-perfectionist`
- `globals`
- `typescript-eslint`
- `@commitlint/config-conventional`

## ESLint

Three composable function exports, each returning a flat config array.
Always spread `recommended()` first.

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

Use `defineConfig` from `eslint/config` for type-safe config authoring.

**Single-package repo (with `defineConfig`):**

```js
import { defineConfig } from 'eslint/config';
import { recommended, typescript } from '@polygonlabs/apps-team-lint';

export default defineConfig([
  ...recommended({ globals: 'node' }),
  ...typescript(),
]);
```

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
| `typescript(options?)` | `{ tsconfigRootDir?: string }` — required in monorepo per-package configs | TS-ESLint recommended rules, type-aware linting (`projectService`), TS import resolver, `consistent-type-imports`, `no-floating-promises`, `no-explicit-any` (warn) |
| `frontend()` | none | `no-default-export` exemption for `.tsx` files |

## Markdownlint

```js
// .markdownlint-cli2.mjs
import { markdownlint } from '@polygonlabs/apps-team-lint/markdownlint';

export default markdownlint;
```

Delete your `.markdownlint-cli2.jsonc` after adding this file.

## Commitlint

```js
// commitlint.config.js
import { commitlint } from '@polygonlabs/apps-team-lint/commitlint';

export default commitlint;
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
