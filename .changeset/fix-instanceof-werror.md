---
"@polygonlabs/verror": patch
"@polygonlabs/logger": patch
---

Fix `instanceof WError` failing across module boundaries when multiple copies of `@polygonlabs/verror` are loaded

`@polygonlabs/verror` now exports `WERROR_SYMBOL` (`Symbol.for('@polygonlabs/verror/is-werror')`). WError and all subclasses carry this symbol as an instance property. Because `Symbol.for()` uses the V8 global registry, the same symbol value is returned in every module copy — unlike `instanceof`, which compares prototype chains and silently returns `false` when two copies of the class exist.

`@polygonlabs/logger` now uses `WERROR_SYMBOL` to identify WError instances in the log hook, fixing a silent failure where WError cause chains were not unwrapped when the host service and the logger each had their own copy of `@polygonlabs/verror` in `node_modules`. `@polygonlabs/verror` is also moved from `dependencies` to `peerDependencies`, ensuring a single shared copy in consuming services.

## Migration

Add `@polygonlabs/verror` to your service's direct `dependencies` if it is not already present — pnpm will warn if the peer is missing.
