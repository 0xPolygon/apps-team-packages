---
---

Adopt the Nx three-tier `tsconfig` pattern: `tsconfig.base.json` at the repo
root owns shared `compilerOptions`; each package has a hub `tsconfig.json`
plus `tsconfig.lib.json` (source / typecheck / library emit) and
`tsconfig.spec.json` (tests + non-source files). `tsconfig.build.json` is
replaced by `tsconfig.lib.json` across all packages. Per-package `typecheck`
scripts now run `tsc -b`.

No consumer-visible behaviour change. Pure tooling refactor — no package
versions bumped, no npm publish, emitted `dist/` payloads are byte-identical
to the pre-migration build.
