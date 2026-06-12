---
'@polygonlabs/apps-team-lint': minor
---

Add first-class Astro support via a new `astro()` ESLint config, available from the `@polygonlabs/apps-team-lint/astro` subpath.

Astro lives on its own subpath so repos without `.astro` files don't load the Astro toolchain. Compose it after `recommended()` and `typescript()`:

```js
import { recommended, typescript } from '@polygonlabs/apps-team-lint';
import { astro } from '@polygonlabs/apps-team-lint/astro';

export default defineConfig([
  ...recommended({ globals: 'browser' }),
  ...typescript(),
  ...astro(),
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
