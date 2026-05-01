# Migration Guide

This guide covers two migration paths to the current chainable
`TypedRegistry` API:

- **From `OpenAPIRegistry`** (`@asteasolutions/zod-to-openapi`) — most
  schemas packages adopting the team-standard registry pattern for the
  first time.
- **From the earlier asserts-based `TypedRegistry`** — schemas packages
  on `@polygonlabs/openapi-registry` <= 1.1.0 that used the
  `asserts this is X` API (`r.registerPath({…}); r.extend(fn);`).

## From `OpenAPIRegistry`

### Pattern 1 — import and constructor

Previously:

```ts
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
const registry = new OpenAPIRegistry();
```

Now:

```ts
import { TypedRegistry } from '@polygonlabs/openapi-registry';
const registry = new TypedRegistry();
```

Runtime behaviour is byte-compatible. Anything reading `registry.definitions` (the OpenAPI generator, codegen plugins, etc.) keeps working without modification.

### Pattern 2 — route registration

Previously, `registerPath` returned `void` and the registry's type was
opaque:

```ts
registry.registerPath({ operationId: 'a', /* … */ });
registry.registerPath({ operationId: 'b', /* … */ });
```

Now, each call returns a `TypedRegistry` typed with the new
`operationId` added. Chain to keep the narrow:

```ts
const registry = new TypedRegistry()
  .registerPath({ operationId: 'a', /* … */ })
  .registerPath({ operationId: 'b', /* … */ });
```

### Pattern 3 — security schemes

Previously, schemes were registered through the generic
`registerComponent`:

```ts
registry.registerComponent('securitySchemes', 'ApiKeyAuth', {
  type: 'apiKey',
  in: 'header',
  name: 'x-api-key'
});
```

Now, use the dedicated chainable method — runtime behaviour is
identical, but the scheme name is added to a type-level `Schemes`
accumulator that downstream `.auth(handlers)` binding consumes:

```ts
const registry = new TypedRegistry()
  .registerSecurityScheme('ApiKeyAuth', {
    type: 'apiKey',
    in: 'header',
    name: 'x-api-key'
  });
```

Per-route `security: [{ ApiKeyAuth: [] }]` declarations on
`registerPath` calls don't change.

### Pattern 4 — locally-invented error schemas

Previously, services defined their own error response shape:

```ts
const ErrorResponseSchema = z.object({ error: z.string() }).openapi('ErrorResponse');
```

Now, reference the canonical schemas from the package:

```ts
import {
  ErrorResponseSchema,
  ValidationErrorResponseSchema
} from '@polygonlabs/openapi-registry/error-schemas';
```

The shapes match exactly what `createErrorHandler` from
`@polygonlabs/express` emits at runtime — `{ error: true, message,
info? }` — so the served spec, the runtime body, and the typed
client agree by construction.

If the schemas package is consumed by `@polygonlabs/zod-to-openapi-heyapi`'s
codegen plugin, re-export under names matching the OpenAPI registered
names:

```ts
export {
  ErrorResponseSchema as ErrorResponse,
  ValidationErrorResponseSchema as ValidationError
} from '@polygonlabs/openapi-registry/error-schemas';
```

### Pattern 5 — exporting the operations manifest

Previously, downstream consumers had no way to read the registered
operations from the registry's type — they re-derived the manifest
from the OpenAPI spec.

Now, derive it from the builder function:

```ts
import type { OperationsOf } from '@polygonlabs/openapi-registry';

export const buildRegistry = () => new TypedRegistry().registerPath(/* … */);

export type Operations = OperationsOf<typeof buildRegistry>;
```

`OperationsOf` returns the accumulated operations manifest and brands
the empty case as a type-level error (catches the silent failure where
every chain return was discarded and the manifest is `{}`).

## From the asserts-based `TypedRegistry`

### Pattern 1 — drop the `: TypedRegistry` annotation and the function-wrapper requirement

Previously, the registry needed an explicit type annotation (TS2775)
and had to be returned from a function for the narrow to flow through
the export boundary:

```ts
export function buildRegistry() {
  const registry: TypedRegistry = new TypedRegistry();
  registry.registerPath({ operationId: 'a', /* … */ });
  registry.registerPath({ operationId: 'b', /* … */ });
  return registry;
}
```

Now, neither is required — the chainable returns flow the narrow
through inferred return types directly:

```ts
export const buildRegistry = () =>
  new TypedRegistry()
    .registerPath({ operationId: 'a', /* … */ })
    .registerPath({ operationId: 'b', /* … */ });
```

### Pattern 2 — `.extend(fn)` becomes `.with(fn)`

Previously, `.extend(fn)` was a statement-form composition that
`asserts this is X`:

```ts
const registry: TypedRegistry = new TypedRegistry();
registry.extend(addCoreRoutes);
registry.extend(addBlockRoutes);
```

Now, `.with(fn)` chains. Helpers take the registry, chain
registrations, and return the chain's final value:

```ts
const registry = new TypedRegistry()
  .with(addCoreRoutes)
  .with(addBlockRoutes);
```

### Pattern 3 — per-domain helpers chain through

Previously, helpers used statement-form against a parameter typed with
the previous accumulator:

```ts
function addBlockRoutes<Prev extends OperationsManifest>(r: TypedRegistry<Prev>) {
  r.registerPath({ operationId: 'a', /* … */ });
  r.registerPath({ operationId: 'b', /* … */ });
  return r;
}
```

Now, helpers chain and return the chain's final value. Generic over
both `Ops` and `Schemes` so the helper preserves whatever the parent
registered before:

```ts
const addBlockRoutes = <
  Ops extends Record<string, RouteWithOpId>,
  Schemes extends Record<string, true>
>(
  r: TypedRegistry<Ops, Schemes>
) =>
  r
    .registerPath({ operationId: 'a', /* … */ })
    .registerPath({ operationId: 'b', /* … */ });
```

### Pattern 4 — `Operations` extraction simplifies

Previously, the operations manifest was extracted with a conditional
type:

```ts
export type Operations =
  ReturnType<typeof buildRegistry> extends TypedRegistry<infer O, Record<string, true>>
    ? O
    : never;
```

Now, use the helper:

```ts
import type { OperationsOf } from '@polygonlabs/openapi-registry';

export type Operations = OperationsOf<typeof buildRegistry>;
```

`OperationsOf` brands the empty-manifest case as a type-level error,
which surfaces the silent "every chain return was discarded" failure
mode at the consumer site.

## Common pitfalls

**Don't drop the chain return.** The chainable API has one silent
failure mode:

```ts
r.registerPath({ /* … */ });   // return discarded
return r;                       // type unchanged from input
```

The runtime side effect happens, but the type-level narrow doesn't
flow through. Always chain or capture:

```ts
return r.registerPath(/* … */); // chain
let r1 = r.registerPath(/* … */); // capture
```

`OperationsOf<typeof buildRegistry>` brands the worst case (every
return discarded — manifest is `{}`) as a type-level error. Partial
discards still under-report. See the README's "The one rule" section.

**Don't annotate the builder's return type.** Inferred returns flow
the narrow through; an explicit annotation discards it:

```ts
export const buildRegistry: () => TypedRegistry = () => new TypedRegistry().registerPath(/* … */);
//                          ^^^^^^^^^^^^^^^^^^ discards the narrow
```

Drop the annotation:

```ts
export const buildRegistry = () => new TypedRegistry().registerPath(/* … */);
```

**Helpers must chain through to the return.** A helper that returns
void (forgot to return the chain) is a TS error at the `.with(fn)`
call site — that's by design. But a helper that returns the parameter
without chaining hides the bug:

```ts
const addRoutes = (r: TypedRegistry) => {
  r.registerPath(/* … */);  // discarded
  return r;                  // returns parameter type, not narrowed
};
```

The parent's accumulator survives via `.with(fn)`'s `this & R`
intersection, so existing routes are preserved — but the helper's
contributions are lost type-side. Same fix: chain through:

```ts
const addRoutes = (r: TypedRegistry) =>
  r.registerPath(/* … */).registerPath(/* … */);
```
