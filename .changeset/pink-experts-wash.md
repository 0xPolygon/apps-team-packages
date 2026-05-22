---
---

Point `prepublishOnly` at `pnpm run build` (no `rm`) in every publishable
package instead of `build:clean`. The previous setting made the `rm -rf
dist out-tsc *.tsbuildinfo` step run during the `changesets publish`
wave, where another package's typecheck could resolve upstream
workspace deps via `dist/` mid-rm and fail with `TS2307`. Observed in
[run 26293267252](https://github.com/0xPolygon/apps-team-packages/actions/runs/26293267252)
during the `@polygonlabs/express@3.0.0` release.

No consumer impact — `prepublishOnly` is an internal lifecycle hook.
`build:clean` itself is unchanged and remains available as a local
recovery tool.
