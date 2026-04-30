# @polygonlabs/openapi-registry

## 1.0.1

### Patch Changes

- 978435a: Initial release of `@polygonlabs/openapi-registry`.

  `TypedRegistry` is a type-accumulating drop-in for `OpenAPIRegistry` from `@asteasolutions/zod-to-openapi`. Two type-level effects ride alongside the runtime calls:
  - Every `registerPath` call narrows the receiver's `Ops` accumulator via `asserts this is X`, so the registry's type carries every registered `operationId` by the time it's returned. Downstream consumers (Express request/response validation, codegen audits, gateway aggregation) read the accumulated `Ops` directly via inferred return types.
  - Every `registerSecurityScheme(name, scheme)` call narrows the receiver's `Schemes` accumulator the same way, so consumers (typed Express auth wiring) can require a handler for every registered scheme at compile time.

  The runtime behaviour is byte-compatible with `OpenAPIRegistry` — `register`, `registerParameter`, `registerComponent`, `registerWebhook`, and the `definitions` getter all forward to the inner registry. `registerSecurityScheme` is a thin wrapper over `inner.registerComponent('securitySchemes', name, scheme)` that exists purely so the type-level narrow on `Schemes` is captured cleanly. Code that treats the registry as a plain `OpenAPIRegistry` sees no behavioural difference.

  The package also ships:
  - `.extend(fn)` — statement-form composition for per-domain helpers without chaining or per-helper boilerplate.
  - `SecuritySchemeObject` — structural shape covering OpenAPI 3.x security schemes (`apiKey`, `http`, `oauth2`, `openIdConnect`).

  See the README for the four asserts-narrowing preconditions (TS2775 explicit annotation, `<const O>` / `<const N>` literal preservation, function wrapper for cross-module narrow, and the phantom witnesses that anchor variance).
