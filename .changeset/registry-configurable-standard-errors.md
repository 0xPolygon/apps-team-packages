---
'@polygonlabs/openapi-registry': minor
---

Make the auto-injected standard error responses configurable per registry

`new TypedRegistry({ standardErrorResponses })` now controls the framework-emitted error responses injected into every `registerPath` call:

- `false` — inject nothing; every route documents exactly the responses it declares.
- `{ serverError?, validationError?, notAuthenticated? }` — override the schema for individual slots; omitted slots keep their defaults.
- Omitted — unchanged default behaviour.

The default shapes document `@polygonlabs/express`'s error middleware, which is correct for services using it but wrong for any other producer: a spec authored with this registry for a non-Express backend would otherwise advertise 500/400/401 shapes its server never emits, and the injected `ErrorResponse` component name can collide with the service's own same-named schema of a different shape. The injection *rules* (when a 400/401/500 is added) are unchanged — only the shapes are configurable.

The option is mirrored at the type level: the `Ops` accumulator reports the configured schema types (or omits the slots entirely under `false`), so `OperationsOf` consumers and codegen'd clients see the shapes the runtime registry actually holds. `inferStandardErrorResponses` accepts the same options as an optional second argument; existing single-argument calls are unaffected.
