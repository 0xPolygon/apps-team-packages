# @polygonlabs/openapi-registry

Type-accumulating drop-in for `@asteasolutions/zod-to-openapi`'s
`OpenAPIRegistry`. Schemas packages compose with `TypedRegistry`;
downstream consumers (Express request/response validation and auth
binding, codegen audits, gateway aggregation) read the accumulated
operations and security schemes via inferred return types.

The runtime behaviour is byte-compatible with `OpenAPIRegistry`. The
additions are type-level: `registerPath` and `registerSecurityScheme`
return a `TypedRegistry` typed with the just-registered entry added.
Chain registration calls; the chain's final value carries every
registered operationId and scheme name in its type.

## Install

```bash
pnpm add @polygonlabs/openapi-registry @asteasolutions/zod-to-openapi zod
```

`zod` and `@asteasolutions/zod-to-openapi` are peer dependencies.
Requires Zod v4 and zod-to-openapi v8.

## Usage

```ts
// schemas/registry.ts
import { TypedRegistry, type OperationsOf } from '@polygonlabs/openapi-registry';

import { addBlockRoutes } from './routes/blocks.ts';
import { addCoreRoutes } from './routes/core.ts';

export const buildRegistry = () =>
  new TypedRegistry()
    .registerSecurityScheme('ApiKeyAuth', {
      type: 'apiKey',
      in: 'header',
      name: 'x-api-key'
    })
    .with(addCoreRoutes)
    .with(addBlockRoutes);

// Operations manifest derived from buildRegistry's inferred return type.
// Express services use this for HandlerMap<Operations, AuthMap>.
export type Operations = OperationsOf<typeof buildRegistry>;
```

```ts
// schemas/routes/blocks.ts
import { z } from 'zod';

import type { RouteWithOpId, TypedRegistry } from '@polygonlabs/openapi-registry';

import { BlockMetadata, NotFound } from '../schemas.ts';

// Generic over the parent's accumulators so the helper preserves
// whatever was registered before `.with(addBlockRoutes)`.
export const addBlockRoutes = <
  Ops extends Record<string, RouteWithOpId>,
  Schemes extends Record<string, true>
>(
  r: TypedRegistry<Ops, Schemes>
) =>
  r.registerPath({
    operationId: 'getBlockMetadata',
    method: 'get',
    path: '/blocks/{blockNumber}',
    request: { params: z.object({ blockNumber: z.coerce.bigint() }) },
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
```

The chain's final value is what `buildRegistry()` returns. Each
`.registerPath` returns a `TypedRegistry` typed with the new operationId
added; each `.registerSecurityScheme` adds the scheme name to a
parallel `Schemes` accumulator; `.with(fn)` runs a domain helper and
returns the helper's chain result intersected with the receiver, so a
misbehaving helper can't shrink the parent's accumulator.

`registerPath` requires `operationId`. RouteConfig upstream types it
optional, but the accumulator keys on it — operations without an
`operationId` are unreachable to typed handler binding downstream.
Always declare one.

## The one rule: chain or capture every registration

The chainable API has one silent failure mode: `r.registerPath({…});`
that drops the return value still mutates the underlying registry at
runtime — the path is registered in the OpenAPI spec — but the
type-level narrow that the return carries is lost. If a downstream
consumer reads the operations manifest from a chain where any link
discarded its return, the accumulated type under-reports.

Always either chain or capture:

```ts
// chain (idiomatic)
return r.registerPath(a).registerPath(b);

// capture (acceptable when imperative branching matters)
let r1 = r.registerPath(a);
if (cond) r1 = r1.registerPath(b);
return r1;

// silent failure — DO NOT
r.registerPath(a);                     // return discarded
r.registerPath(b);                     // return discarded
return r;                              // type is unchanged from input
```

The `OperationsOf<typeof buildRegistry>` brand catches the worst case
(every link discarded — manifest is `{}`) by resolving to a type-level
error string, which surfaces in IDE hover at the consumer site.
Partial discards (some chained, some discarded) under-report without
the brand firing.

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

## Serving the OpenAPI document

`registry.definitions` is the same getter `OpenAPIRegistry` exposes —
forwarded verbatim — so `OpenApiGeneratorV3` / `OpenApiGeneratorV31`
read the registry without any TypedRegistry-specific glue. The single
source of truth feeds the served spec, the interactive docs, and (via
the typed `Operations` manifest) the runtime router:

```ts
import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { apiReference } from '@scalar/express-api-reference';
import { Router } from 'express';

import type { TypedRegistry } from '@polygonlabs/openapi-registry';

export function createOpenApiRouter(registry: TypedRegistry): Router {
  const spec = new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.0',
    info: { title: 'My service', version: 'v1' },
    servers: [{ url: '/' }]
  });

  const router = Router();
  router.get('/openapi.json', (_req, res) => res.json(spec));
  router.use('/docs', apiReference({ content: spec }));
  return router;
}
```

The `apiReference` import is `@scalar/express-api-reference` — the
team-standard interactive docs UI. Drop it if you only need the raw
JSON.

## Security scheme accumulation

Routes that need authentication declare it via OpenAPI's `security`
field on the route config. To make those declarations type-safe — both
in the registry (which schemes exist?) and downstream (does every
declared scheme have a handler?) — register schemes with the dedicated
`registerSecurityScheme(name, scheme)` method:

```ts
const registry = new TypedRegistry()
  .registerSecurityScheme('apiKey', { type: 'apiKey', name: 'x-api-key', in: 'header' })
  .registerSecurityScheme('bearer', { type: 'http', scheme: 'bearer' })
  .registerPath({
    operationId: 'rebalance',
    method: 'post',
    path: '/management/rebalance',
    security: [{ apiKey: [] }]
    // …
  });
```

`registerSecurityScheme` runtime-delegates to
`inner.registerComponent('securitySchemes', name, scheme)`, so the
OpenAPI generator picks it up exactly as if it had been registered the
asteasolutions way. The dedicated method exists for the type-level
narrow on `Schemes` — split out from the generic `registerComponent`
because TypeScript overload resolution has trouble preserving the
literal `name` type when the narrow is conditional on the component
type.

Downstream consumers (notably `@polygonlabs/express/registry`'s
`.auth(handlers)` binding) read `keyof Schemes` to require an
exhaustive auth handler map at compile time:

```ts
type Names = keyof typeof registry['schemes']; // 'apiKey' | 'bearer'
```

For non-security components (`'schemas'`, `'parameters'`, etc.) use
the forwarded `registerComponent(...)` method — same runtime behaviour
as asteasolutions, no type-level effect on the accumulators.

## `.with(fn)` composition

Per-domain helpers compose without per-helper boilerplate. Each helper
takes the registry, chains registrations, and returns the chain's
final value:

```ts
export const buildRegistry = () =>
  new TypedRegistry()
    .with(addCoreRoutes)
    .with(addBlockRoutes)
    .with(addMessageRoutes);
```

`.with(fn)` returns `this & R` (the receiver intersected with the
helper's inferred return type). A helper that drops the parent
narrow — say, by ignoring its argument and constructing a fresh
registry — can't shrink the accumulator: existing entries survive the
intersection. A helper that returns void (forgot to chain through to
the return) is a TS error at the `.with(fn)` call site, not a silent
empty manifest downstream.

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
a plain `OpenAPIRegistry` (the OpenAPI generator, codegen plugins)
sees no behavioural difference.

`registerComponent` and `registerWebhook` return `this` so they fit
into a chain without breaking it. `register` and `registerParameter`
return the registered schema (matching the asteasolutions API) and so
don't chain — typical use is

```ts
export const Foo = registry.register('Foo', z.object({ ... }));
```

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

new TypedRegistry().registerPath({
  method: 'post',
  path: '/cycle/pause',
  operationId: 'pauseCycle',
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: { /* … */ },
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

### Re-exporting from a schemas package read by codegen

Any schemas package consumed by `@polygonlabs/zod-to-openapi-heyapi`'s
codegen plugin must satisfy the plugin's audit: every registered
schema's exported binding name has to match its `.openapi('Name', …)`
registration name. The canonical schemas register as `ErrorResponse`
and `ValidationErrorResponse` but their export bindings are
`ErrorResponseSchema` and `ValidationErrorResponseSchema`. Re-export
them under matching aliases when surfacing them from a schemas
package the plugin reads:

```ts
// schemas package barrel
export {
  ErrorResponseSchema as ErrorResponse,
  ValidationErrorResponseSchema as ValidationError
} from '@polygonlabs/openapi-registry/error-schemas';
```

This isn't required if you only consume the schemas inside a service
runtime — the plugin's audit only fires at codegen time.

## Migration

See [`MIGRATION.md`](./MIGRATION.md) for migration from `OpenAPIRegistry`
or earlier (asserts-based) `TypedRegistry` shapes.
