---
"@polygonlabs/viem-event-watcher": patch
---

Republish with the correct published `exports` map. The `1.0.0` artifact was published in a way that did not apply `publishConfig.exports`, so it shipped the development `exports` — including the `@polygonlabs/source` condition pointing at `./src/index.ts`, which is not part of the published tarball (`files` ships only `dist`). Consumers that resolve through the `@polygonlabs/source` condition (any monorepo configured with `resolve.conditions: ['@polygonlabs/source']`, e.g. a Vitest/Vite setup) therefore failed to resolve the package — `Failed to resolve entry for package "@polygonlabs/viem-event-watcher"` — even though plain Node resolution via the `import` condition worked.

This release republishes via the standard pnpm/changesets pipeline, which applies `publishConfig.exports` so the published package exposes only `types` and `import` (→ `dist/`), matching every other `@polygonlabs/*` package. No source changes — the package code is unchanged from `1.0.0`.
