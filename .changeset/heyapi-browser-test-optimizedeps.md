---
---

Stabilise `@polygonlabs/zod-to-openapi-heyapi`'s browser-mode test suite by
pre-bundling the React JSX runtime in `vitest.config.ts`
(`optimizeDeps.include`). With `esbuild.jsx: 'automatic'`, the JSX transform
injects `react/jsx-dev-runtime` at render time — it is in no source `import`,
so Vite's initial dep scan missed it, then discovered it on the first hook
render, re-optimised, and forced a page reload that raced the in-flight
dynamic import of the test module ("Failed to fetch dynamically imported
module"). Declaring the runtime up front eliminates the mid-run re-optimise
and the resulting flake.

Empty changeset: test-config only, `vitest.config.ts` is not in the package's
published `files`, so there is no consumer-facing change to version.
