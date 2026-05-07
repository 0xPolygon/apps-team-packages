---
---

Apply the canonical `tsconfig.build.json` + split `build`/`build:clean`
pattern uniformly across every published package in the monorepo.

## Why this exists

The recurring "incremental tsc skipped a file" failure has hit the
chainable-API release wave twice — once for `@polygonlabs/express`
publishing without `notFound.js`, once leaving `@polygonlabs/verror`'s
local `dist/` missing `http.js`. The root cause is structural:
`composite: true` + `tsc -p` (single-project mode) uses an up-to-date
check that compares src mtimes against the `*.tsbuildinfo` mtime,
**never** against the actual files in `dist/`. External mutations to
`dist/` (interrupted publishes, manual rm, branch operations, broken
prior-build state) leave the tsbuildinfo claiming up-to-date while
`dist/` is incomplete; the next `tsc -p` silently no-ops and exits 0.

PR #40 fixed this for the three packages on the chainable-API critical
path (`apps-team-lint`, `express`, `openapi-registry`). This PR ports
the same canonical pattern across the remaining six published packages
(`logger`, `verror`, `zod-codecs`, `zod-to-openapi-heyapi`,
`sync-github-releases`, `wallet-kit`) so every publish in the repo runs
through the same publish-safe path.

## What changed

Every published package now has:

```jsonc
// tsconfig.build.json
{
  "compilerOptions": {
    "composite": true,
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "customConditions": []   // override inherited @polygonlabs/source
  }
}

// package.json
{
  "scripts": {
    "build":          "pnpm run typecheck && tsc -p tsconfig.build.json",
    "build:clean":    "pnpm run typecheck && rm -rf dist *.tsbuildinfo && tsc -p tsconfig.build.json",
    "prepublishOnly": "pnpm run build:clean"
  }
}
```

`build` stays fast and incremental for dev iteration. `build:clean` is
the publish-safe path: it wipes `dist/` and `*.tsbuildinfo` so tsc has
no stale cache to consult, then emits from a clean slate.
`prepublishOnly` runs `build:clean` so every publish — local recovery,
CI, manual — goes through the same structural guard.

`customConditions: []` on every `tsconfig.build.json` overrides the
`@polygonlabs/source` condition inherited from each package's
`tsconfig.json`. Build-time emit must reference workspace dependencies
via their published `dist/.d.ts` (Node default resolution), not their
`src/`. Today this produces zero diff in emitted output but it defends
against future drift between a workspace dep's source and its published
type surface.

## Zero diff in emitted output

Verified by building each package on `origin/main`, snapshotting `dist/`,
applying this PR, rebuilding, and diffing. No emitted bytes change.
