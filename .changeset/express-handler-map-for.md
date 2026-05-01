---
'@polygonlabs/express': major
---

Remove `defineHandlers<Ops, AuthMap>()` in favour of `HandlerMapFor<F, AuthMap>` + `satisfies`.

## Breaking changes

`defineHandlers<Operations, AuthMap>()` is removed. The two-call form was a workaround for TypeScript's lack of partial type-argument application; modern TS has `satisfies` which obviates it. Per-domain handler bags now look like:

```ts
// before
import type { Operations } from '@my/schemas';
import type { AppAuthMap } from '../auth.ts';
import { defineHandlers } from '@polygonlabs/express/registry';

export const managementHandlers = defineHandlers<Operations, AppAuthMap>()({
  rebalance: (req, res) => { /* … */ }
});

// after
import type { HandlerMapFor } from '@polygonlabs/express/registry';
import type { buildRegistry } from '@my/schemas';
import type { AppAuthMap } from '../auth.ts';

export const managementHandlers = {
  rebalance: (req, res) => { /* … */ }
} satisfies Partial<HandlerMapFor<typeof buildRegistry, AppAuthMap>>;
```

Consumers no longer import a separate `Operations` type alias from the schemas package — `HandlerMapFor<typeof buildRegistry, AuthMap>` derives the manifest from the builder function's inferred return type.

## New helpers

- `HandlerMapFor<F, AuthMap>` — handler-map type for a registry-builder function. Use with `satisfies Partial<HandlerMapFor<…>>` for typed per-domain bags.
- `AuthHandlerMapFor<F>` — auth-handler-map type for a registry-builder function. Use with `satisfies` when defining auth handlers.
- `OperationsOf` and `SchemesOf` are re-exported from `@polygonlabs/openapi-registry` for convenience.

## Peer dependency bump

Requires `@polygonlabs/openapi-registry` major version corresponding to the chainable-API release (registry-side type changes are visible via the structural reads in `RegistryOps<R>` / `RegistrySchemes<R>`).

## Build hygiene

The build now cleans `dist/` + `*.tsbuildinfo` before `tsc` and verifies each `exports` entry point loads at the end. Catches the "incremental tsc skipped a file" failure mode that broke the initial 1.0.x npm publish (compiled `dist/` was missing `notFound.js`).
