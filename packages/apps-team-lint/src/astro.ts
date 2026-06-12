import eslintPluginAstro from 'eslint-plugin-astro';
import { importX } from 'eslint-plugin-import-x';
import perfectionist from 'eslint-plugin-perfectionist';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

import { astroFiles, astroScriptFiles, sortImportsOptions } from './constants.ts';

export interface AstroOptions {
  /**
   * Enable the jsx-a11y accessibility ruleset (recommended tier) on `.astro`
   * templates. On by default — the team treats accessibility as a baseline,
   * not an opt-in. Set to `false` only for genuinely internal tooling where
   * a11y findings are noise rather than defects.
   */
  a11y?: boolean;
}

/**
 * ESLint config for Astro components. Compose **after** `recommended()` and
 * `typescript()` so the blocks below win where they overlap:
 *
 * ```js
 * export default defineConfig([
 *   ...recommended({ globals: 'browser' }),
 *   ...typescript(),
 *   ...astro(),
 * ]);
 * ```
 *
 * `eslint-plugin-astro`'s `recommended` config already wires the
 * `astro-eslint-parser`, the `<script>`-extracting processor, and the correct
 * globals per region (Node for the build-time frontmatter, browser for client
 * `<script>` blocks), so this export does not re-declare any of that. It adds:
 *
 * - the `client-side-ts` processor, so client `<script>` blocks lint as
 *   TypeScript — inline `<script>` is Astro's first-class, documented pattern
 *   ("Processed! Bundled! TypeScript!"), and a shared config must not reject it;
 * - the TypeScript parser for the frontmatter, so typed frontmatter parses;
 * - the team's import-sorting + duplicate-import + `no-param-reassign` rules on
 *   the frontmatter (which `recommended()`/`typescript()` skip — their globs
 *   match the virtual `<script>` files but not the `.astro` file itself);
 * - `astro/no-set-html-directive` as a security error;
 * - the jsx-a11y recommended ruleset (a11y on by default; see `AstroOptions`).
 *
 * Type-*aware* rules do not run inside `<script>` blocks: the processor's
 * virtual `*.astro/*.ts` files are not part of any tsconfig project, so a
 * type-aware rule run against them throws "requires type information". The
 * reset block below disables them there. `.astro` type-checking is `astro
 * check`/`tsc`'s job, not ESLint's.
 */
export function astro(options?: AstroOptions) {
  const a11y = options?.a11y ?? true;

  const pluginConfigs = a11y
    ? [
        ...eslintPluginAstro.configs.recommended,
        ...eslintPluginAstro.configs['jsx-a11y-recommended']
      ]
    : [...eslintPluginAstro.configs.recommended];

  return defineConfig([
    globalIgnores(['**/.astro']),
    ...pluginConfigs,
    {
      // Lint client `<script>` blocks as TypeScript. The default `astro/astro`
      // processor parses inline `<script>` as plain JS, so TS syntax there is a
      // fatal parse error — but inline `<script>` with TypeScript is Astro's
      // own documented, bundled pattern. `client-side-ts` extracts each script
      // to a `*.astro/*.ts` virtual file (handled by the reset block below).
      name: '@polygonlabs/apps-team-lint/astro-client-side-ts',
      files: [astroFiles],
      processor: 'astro/client-side-ts'
    },
    {
      // `eslint-plugin-astro`'s flat `recommended` config registers
      // `astro-eslint-parser` but leaves its inner parser at the default
      // (plain JS), so a typed frontmatter (`interface Props`, `const x: T`)
      // fails to parse. Point the inner parser at typescript-eslint so the
      // frontmatter — which is always TypeScript — parses.
      name: '@polygonlabs/apps-team-lint/astro-frontmatter',
      files: [astroFiles],
      languageOptions: {
        parserOptions: {
          parser: tseslint.parser
        }
      },
      plugins: {
        perfectionist,
        'import-x': importX
      },
      rules: {
        'perfectionist/sort-imports': ['error', sortImportsOptions],
        'import-x/no-duplicates': ['error'],
        'no-param-reassign': 'error'
      }
    },
    {
      // `astro/no-set-html-directive` is the lone security error: a clean XSS
      // sink ban with ~no false positives. We deliberately do NOT enable
      // `astro/no-unsafe-inline-scripts` — despite its name it bans *every*
      // inline `<script>` without a `src`, including Astro's idiomatic
      // `<script>import './x.js'</script>` bundling pattern. CSP-strict
      // external-only scripts is an app-level policy a repo can opt into, not a
      // team-wide error. Don't add it back here.
      name: '@polygonlabs/apps-team-lint/astro-security',
      files: [astroFiles],
      rules: {
        'astro/no-set-html-directive': 'error'
      }
    },
    {
      // The Astro processor extracts client `<script>` blocks into virtual
      // files (`*.astro/*.js` / `*.astro/*.ts`). The `.ts` ones match
      // `typescript()`'s glob, but they are not part of any tsconfig project —
      // so any type-aware rule run against them throws "requires type
      // information". Drop type info and disable the type-aware rules here;
      // `.astro` type-checking is `astro check`/`tsc`'s job, not ESLint's.
      name: '@polygonlabs/apps-team-lint/astro-script-no-type-aware',
      files: astroScriptFiles,
      languageOptions: {
        parserOptions: {
          projectService: false,
          project: null
        }
      },
      rules: {
        '@typescript-eslint/no-floating-promises': 'off',
        'polygon/no-discarded-typed-registry-chain': 'off'
      }
    }
  ]);
}
