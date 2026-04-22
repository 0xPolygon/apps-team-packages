---
'@polygonlabs/logger': patch
'@polygonlabs/verror': patch
---

Standardise the `exports` shape in `package.json` on the team-standards
`@polygonlabs/source` three-condition pattern: workspace consumers resolve
`./src/index.ts` via the custom condition (build-free typecheck), published
consumers continue to get `./dist/...` via `publishConfig.exports`.
Previously `@polygonlabs/verror` used a `types: ./src, import: ./src`
variant and `@polygonlabs/logger` pointed exclusively at `./dist` with no
source condition at all — both now share a single uniform shape alongside
any other TypeScript-consumed package in the workspace. No change for npm
consumers.
