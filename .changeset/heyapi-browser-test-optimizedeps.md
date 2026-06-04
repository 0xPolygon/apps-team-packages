---
---

Two test-infrastructure changes to `@polygonlabs/zod-to-openapi-heyapi`'s
browser-mode suite. Both are dev-only — they touch `vitest.config.ts`,
`devDependencies`, and `pretest`, none of which are in the package's
published `files` — so there is no consumer-facing change to version.

**Pre-bundle the React JSX runtime** (`vitest.config.ts`,
`optimizeDeps.include`). With `esbuild.jsx: 'automatic'`, the JSX transform
injects `react/jsx-dev-runtime` at render time — it is in no source `import`,
so Vite's initial dep scan missed it, then discovered it on the first hook
render, re-optimised, and forced a page reload that raced the in-flight
dynamic import of the test module ("Failed to fetch dynamically imported
module"). Declaring the runtime up front eliminates the mid-run re-optimise
and the resulting flake.

**Provision the browser declaratively instead of via a `pretest` hook, and
fix the install hang on Node 24.** Replaced
`"pretest": "playwright install chromium"` (which re-ran the install before
*every* test invocation) with a `@playwright/browser-chromium` devDependency
that downloads the binary once at install time via its package install hook
(added to `onlyBuiltDependencies` so our supply-chain block on dependency
scripts permits it).

`playwright` and `@playwright/browser-chromium` are pinned to the same exact
version, **`1.60.0`**, for two reasons:

- **Node 24 install hang.** Playwright 1.59.1's installer hangs on macOS
  arm64 / Node 24 (our `.nvmrc` is 24): the browser download reaches 100%,
  then the process never extracts or exits. This is the 6-hour CI hang
  (the job ran until the timeout killed it) and it reproduced locally.
  Fixed upstream in 1.60.0
  (microsoft/playwright#41092, #40998). Pin to >= 1.60.0; do not downgrade.
- **Version coupling.** Playwright ties each release to a specific browser
  revision, so the launcher and the binary package must be the same version
  — a caret range let them resolve independently (1.59.1 / 1.60.0) and the
  suite failed to find the browser.
