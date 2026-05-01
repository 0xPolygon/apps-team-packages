# @polygonlabs/openapi-registry

Type-accumulating drop-in for `@asteasolutions/zod-to-openapi`'s
`OpenAPIRegistry`. Schemas packages compose with `TypedRegistry`;
downstream consumers (Express request/response validation and auth
binding, codegen audits, gateway aggregation) read the accumulated
operations and security schemes via inferred return types.

The runtime behaviour is byte-compatible with `OpenAPIRegistry`. The
additions are two type-level accumulators — every `registerPath` call
narrows the receiver's `Ops`, and every `registerSecurityScheme` call
narrows the receiver's `Schemes`. The `.extend(fn)` method composes
per-domain helpers without chaining.

## Install

```bash
pnpm add @polygonlabs/openapi-registry @asteasolutions/zod-to-openapi zod
```

`zod` and `@asteasolutions/zod-to-openapi` are peer dependencies.
Requires Zod v4 and zod-to-openapi v8.

## Usage

```ts
// schemas/registry.ts
import { TypedRegistry } from '@polygonlabs/openapi-registry';

import { addBlockRoutes } from './routes/blocks.ts';
import { addCoreRoutes } from './routes/core.ts';
import { addMessageRoutes } from './routes/messages.ts';

export function buildRegistry() {
  // Explicit `: TypedRegistry` annotation is required (TS2775 — see below).
  const registry: TypedRegistry = new TypedRegistry();

  registry.extend(addCoreRoutes);
  registry.extend(addBlockRoutes);
  registry.extend(addMessageRoutes);

  return registry;
}

// The accumulated operations type, derived from buildRegistry's inferred
// return type. Express services use this for HandlerMap<Operations>.
export type Operations =
  ReturnType<typeof buildRegistry> extends TypedRegistry<infer O> ? O : never;
```

```ts
// schemas/routes/blocks.ts
import { z } from 'zod';

import type { OperationsManifest, TypedRegistry } from '@polygonlabs/openapi-registry';

import { BlockMetadata, NotFound } from '../schemas.ts';

export function addBlockRoutes<Prev extends OperationsManifest>(r: TypedRegistry<Prev>) {
  r.registerPath({
    operationId: 'getBlockMetadata',
    method: 'get',
    path: '/blocks/{blockNumber}',
    request: {
      params: z.object({ blockNumber: z.coerce.bigint() })
    },
    responses: {
      200: {
        description: 'Block metadata',
        content: { 'application/json': { schema: BlockMetadata } }
      },
      404: {
        description: 'Not found',
        content: { 'application/json': { schema: NotFound } }
      }
    }
  });
  return r;
}
```

The helpers stay statement-form. The accumulator narrows on every
`registerPath` call. Helpers that receive the registry can return it
verbatim — `.extend(fn)` reads the inferred return type and intersects
it with the current `this`, so `Operations` carries every registered
operationId by the time `buildRegistry()` returns.

## Why a TypedRegistry instead of `OpenAPIRegistry` directly

The asteasolutions registry doesn't carry registered operations in its
type — the `definitions` array is `unknown[]` once it crosses a module
boundary, so any consumer that wants per-operation typed access has to
re-derive the manifest from the OpenAPI spec.

`TypedRegistry` keeps the accumulated operations in the type, with no
duplication. The Express integration (`@polygonlabs/express/registry`)
reads it directly:

```ts
type HandlerMap<Ops> = { [K in keyof Ops]: Handler<Ops[K]> };
```

Missing handlers are a TS error at the wiring file, not a runtime drift
warning.

## Four preconditions for the asserts narrowing

`registerPath` is declared as `asserts this is TypedRegistry<…>`. The
narrowing only materialises if all four of these are true; skip any one
and the narrow silently no-ops.

### 1. TS2775 — explicit type annotation on the variable

```ts
//                  vvvvvvvvvvvvvv  required
const registry: TypedRegistry = new TypedRegistry();
registry.registerPath({ … });  // narrow applies
```

```ts
const registry = new TypedRegistry();   // no annotation
registry.registerPath({ … });           // TS2775 error: assertions require
                                        // every name in the call target to
                                        // be declared with an explicit type
                                        // annotation
```

This is a TypeScript language rule, not something the package can
work around with cleverer types — TS2775 checks the variable's
declaration form, not whether the right-hand side has a known return
type. A factory function would still need the annotation, so the
package deliberately doesn't ship one — `new TypedRegistry()` is the
only construction site.

### 2. `<const O>` on `registerPath` for literal-type preservation

`registerPath<const O extends RouteWithOpId>(route: O)` — the `const`
modifier (TS 5.0+) tells the compiler to infer `O` with its literal
types preserved. Without it, `operationId: 'getMessage'` widens to
`string`, and the accumulator key becomes `[string]` instead of
`['getMessage']`.

### 3. Function wrapper preserves the narrow across the export boundary

```ts
// LOSES the narrow at the export boundary:
export const registry: TypedRegistry = new TypedRegistry();
registry.registerPath({ operationId: 'a', … });
// Importers see TypedRegistry<{}> — the narrow that fired locally is gone.

// PRESERVES the narrow:
export function buildRegistry() {
  const registry: TypedRegistry = new TypedRegistry();
  registry.registerPath({ operationId: 'a', … });
  return registry;
}
// The inferred return type of buildRegistry captures the post-narrow type.
// `ReturnType<typeof buildRegistry>` is TypedRegistry<{ a: … }>.
```

This is why all team schemas packages compose inside a function.

### 4. The phantom `declare readonly ops` / `declare readonly schemes` witnesses anchor variance

Without each generic appearing in a real return-position somewhere in
the class, TypeScript treats it as variance-unused (bivariant), and
`asserts this is X` doesn't narrow `this`. The `declare readonly ops`
and `declare readonly schemes` fields exist solely to anchor the
variance — they're never read at runtime.

If you ever refactor `TypedRegistry` and remove either field, the
asserts narrowing silently no-ops. Don't.

The `Schemes` accumulator deliberately uses a presence-map shape
(`Record<string, true>`) keyed by scheme name rather than a string
union with a `never` default — the latter triggers a TypeScript quirk
where `asserts this is X` narrowing on the second generic doesn't fire.
Consumers read scheme names via `keyof Schemes`.

## Security scheme accumulation

Routes that need authentication declare it via OpenAPI's `security`
field on the route config. To make those declarations type-safe — both
in the registry (which schemes exist?) and downstream (does every
declared scheme have a handler?) — register schemes with the
dedicated `registerSecurityScheme(name, scheme)` method:

```ts
const registry: TypedRegistry = new TypedRegistry();

registry.registerSecurityScheme('apiKey', {
  type: 'apiKey',
  name: 'x-api-key',
  in: 'header'
});
registry.registerSecurityScheme('bearer', { type: 'http', scheme: 'bearer' });

registry.registerPath({
  operationId: 'rebalance',
  method: 'post',
  path: '/management/rebalance',
  security: [{ apiKey: [] }],
  // …
});
```

`registerSecurityScheme` runtime-delegates to
`inner.registerComponent('securitySchemes', name, scheme)`, so the
OpenAPI generator picks it up exactly as if it had been registered the
asteasolutions way. The dedicated method exists for the type-level
narrow on `Schemes` — it's split out from the generic
`registerComponent` because TypeScript overload resolution has trouble
preserving the literal `name` type when the narrow is conditional on
the component type.

Downstream consumers (notably `@polygonlabs/express/registry`'s
`.auth(handlers)` binding) read `keyof Schemes` to require an exhaustive
auth handler map at compile time:

```ts
type Names = keyof typeof registry['schemes'];  // 'apiKey' | 'bearer'
```

For non-security components (`'schemas'`, `'parameters'`, etc.) use the
forwarded `registerComponent(...)` method — same runtime behaviour as
asteasolutions, no type-level effect on the accumulators.

## `.extend(fn)` composition

Per-domain helpers compose without chaining and without per-helper
`asserts` boilerplate:

```ts
const registry: TypedRegistry = new TypedRegistry();
registry.extend(addCoreRoutes);
registry.extend(addBlockRoutes);
registry.extend(addMessageRoutes);
```

`extend(fn)` is declared as `asserts this is R` where `R` is the
helper's inferred return type. The asserts is intersected with the
current `this`, so a misbehaving helper that drops Ops can't actually
reduce the accumulator: existing operations survive.

## Compatibility with codec metadata

`@polygonlabs/zod-codecs` (>=1.1.0) ships
`extendZodAndCodecsWithOpenApi` from `@polygonlabs/zod-codecs/openapi`
— the asteasolutions `extendZodWithOpenApi` patch only reaches
`ZodType`, but in Zod v4 codecs are siblings of `ZodType`, not
subclasses. Call this once at the top of the schemas file:

```ts
import { z } from 'zod';
import { Int64Codec } from '@polygonlabs/zod-codecs';
import { extendZodAndCodecsWithOpenApi } from '@polygonlabs/zod-codecs/openapi';

extendZodAndCodecsWithOpenApi(z);

export const BlockMetadata = z
  .object({
    number: Int64Codec.openapi({ description: 'Block height — int64.' })
  })
  .openapi('BlockMetadata');
```

`TypedRegistry` reads codec-aware schemas without any extra wiring —
the asteasolutions extension and the codec patch are separate layers,
both transparent to the registry.

## Forwarded methods

`TypedRegistry` forwards `register`, `registerParameter`,
`registerComponent`, `registerWebhook`, and the `definitions` getter
verbatim to the inner `OpenAPIRegistry`. Code reading the registry as
a plain `OpenAPIRegistry` (the OpenAPI generator,
`OpenApiGeneratorV31`, codegen plugins) sees no behavioural
difference.

## Canonical error response schemas

The subpath `@polygonlabs/openapi-registry/error-schemas` exports the
canonical Zod schemas for the standard error response shapes the
registry-driven Express router (in `@polygonlabs/express`) emits:

- `ErrorResponseSchema` — `{ error: true, message, info? }`. The
  generic shape `createErrorHandler` emits for `HTTPError` (401, 403,
  409, …) and non-`HTTPError` 500s.
- `ValidationErrorResponseSchema` — narrowed shape for the 400s the
  registry's request validator emits. `info` is keyed by section name
  (`params` / `query` / `body` / `headers`) with each value the
  `z.treeifyError` tree for that section.
- `ZodErrorTreeSchema` / `ValidationErrorInfoSchema` — building blocks
  for the above.

Use them in `responses[code].content` slots so the served spec
documents what clients will actually see, with no copy-pasted
per-service definitions:

```ts
import { ErrorResponseSchema } from '@polygonlabs/openapi-registry/error-schemas';

registry.registerPath({
  method: 'post',
  path: '/cycle/pause',
  operationId: 'pauseCycle',
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: {
      /* … */
    },
    401: {
      description: 'Missing or invalid x-api-key header',
      content: { 'application/json': { schema: ErrorResponseSchema } }
    }
  }
});
```

The schemas have zero Express-runtime imports — only `zod` and
`@asteasolutions/zod-to-openapi` — so a schemas-only package can
register the canonical 400 / 401 / 5xx response shapes without a
transitive dep on Express + pino + Sentry.

`@polygonlabs/express/registry` re-exports the same schema instances
(literal-equal: `===`), so consumers that already import them from
the express package keep working. New code should prefer the
openapi-registry path.

## Migration from `OpenAPIRegistry`

For an existing schemas package:

1. Swap the import:

   ```ts
   // before
   import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
   // after
   import { TypedRegistry } from '@polygonlabs/openapi-registry';
   ```

2. Replace `new OpenAPIRegistry()` with `new TypedRegistry()`.
3. Add the `: TypedRegistry` annotation on the variable.
4. Wrap the composition in `buildRegistry()` if it isn't already, and
   export the function (not the registry instance directly).

The OpenAPI generator and any code reading `.definitions` continues
to work without modification.
