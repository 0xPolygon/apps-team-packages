---
---

Fix the npm-release pipeline for the chainable-API release wave. Two
publishing failures from the changesets release run that merged PR #38:

- **`@polygonlabs/apps-team-lint@2.1.0`** — `prepublishOnly` ran `tsc
  --noEmit` against the package's `tsconfig.json`, which now includes
  `test/**/*.ts` and `vitest.config.ts` for the new
  `polygon/no-discarded-typed-registry-chain` rule's RuleTester suite.
  But `tsconfig.build.json` (which extends `tsconfig.json`) sets
  `rootDir: "src"` for the publish build, and the inherited test
  inputs trip TS6059 ("not under rootDir"). Fixed by overriding
  `include: ["src/**/*.ts"]` on `tsconfig.build.json` so the publish
  build only sees src files. The dev typecheck still covers tests.
- **`@polygonlabs/express@2.0.0`** — `verify-dist-exports.mjs`
  (introduced earlier in this branch as a publish-time runtime
  integrity check) failed because in changesets release shards,
  `prepublishOnly` runs only for packages being published. Sibling
  workspace packages whose dist symlinks via pnpm's workspace setup
  (e.g. `@polygonlabs/logger`, `@polygonlabs/verror`) may not have
  been built in the same shard. The verifier's dynamic-import step
  walked into those unbuilt sibling dists and threw
  `Cannot find module .../packages/logger/dist/index.js`. The
  symptom was a CI environment artifact, not a real
  published-artifact integrity bug. Removed the verifier entirely —
  the structural `rm -rf dist *.tsbuildinfo` in `build:clean`
  prevents the original "incremental tsc skipped a file" failure
  mode it was originally meant to catch, leaving no real job for the
  runtime check.

Also adopts the canonical build-script pattern (split `build` from
`build:clean`):

```jsonc
{
  "build":          "pnpm run typecheck && tsc -p tsconfig.build.json",
  "build:clean":    "pnpm run typecheck && rm -rf dist *.tsbuildinfo && tsc -p tsconfig.build.json",
  "prepublishOnly": "pnpm run build:clean"
}
```

`build` is the fast incremental path for dev iteration; `build:clean`
is the publish-safe path that eliminates `*.tsbuildinfo` so tsc has no
stale cache to consult. `prepublishOnly` runs `build:clean` so every
publish rebuilds from a clean slate.

This pattern only applies to the three packages this release wave
touched. The other six published packages (`logger`, `verror`,
`zod-codecs`, `zod-to-openapi-heyapi`, `sync-github-releases`,
`wallet-kit`) are tracked under the build-tooling structural-fix PR
that ports the same canonical pattern across every published package
with composite-mode tsconfigs.
