# @polygonlabs/openapi-registry

## 2.0.0

### Major Changes

- 1b5d48f: Replace the asserts-based API with chainable returns; add `OperationsOf<F>` and `SchemesOf<F>` helpers.

  ## Breaking changes

  `registerPath` and `registerSecurityScheme` now return a narrower `TypedRegistry` instead of asserting `this is X`. Chain registrations to keep the type-level narrow:

  ```ts
  // before
  const registry: TypedRegistry = new TypedRegistry();
  registry.registerPath({ operationId: 'a' /* … */ });

  // after
  const registry = new TypedRegistry().registerPath({ operationId: 'a' /* … */ });
  ```

  `.extend(fn)` is renamed to `.with(fn)` and returns `this & R` (the helper's chain result intersected with the receiver). Per-domain helpers chain through:

  ```ts
  // before
  function addRoutes<Prev>(r: TypedRegistry<Prev>) {
    r.registerPath(/* … */);
    return r;
  }
  registry.extend(addRoutes);

  // after
  const addRoutes = <Ops, Schemes>(r: TypedRegistry<Ops, Schemes>) => r.registerPath(/* … */);
  registry.with(addRoutes);
  ```

  The asserts-based footguns are gone: no `: TypedRegistry` annotation requirement (TS2775), no function-wrapper requirement, no phantom-witness fields. The variable holding the chain's final value picks up the accumulated narrow without any annotation.

  `registerComponent` and `registerWebhook` now return `this` (chainable). `register` and `registerParameter` keep their schema-returning shape (matching the asteasolutions API).

  ## New helpers
  - `OperationsOf<F extends () => TypedRegistry<...>>` — extract the operations manifest from a builder function. Brands the empty-manifest case (`Operations` resolves to `{}`) as a type-level error so a downstream consumer sees the bug at the `satisfies` / `HandlerMap` use site instead of silently iterating an empty object.
  - `SchemesOf<F>` — extract the security scheme presence-map from a builder function.

  ## New silent-failure mode

  The chainable API has one new failure mode: `r.registerPath({ … });` that drops the return still mutates the underlying registry at runtime, but the type-level narrow is lost. Two complementary defences:
  - **`OperationsOf<F>`** brands the worst case (every link discarded → manifest `{}`) as a type-level error string, so downstream consumers see the bug at the `satisfies HandlerMapFor<F>` use site.
  - **`@polygonlabs/apps-team-lint`'s `polygon/no-discarded-typed-registry-chain`** rule (shipped in the same release wave) catches partial discards at lint time — type-aware, only fires on real `TypedRegistry` receivers. Enabled at `error` in the `typescript()` preset, so consuming repos pick it up automatically when they update.

  See README "The one rule".

  ## Build hygiene

  Both `@polygonlabs/openapi-registry` and `@polygonlabs/express` builds now clean `dist/` + `*.tsbuildinfo` before `tsc` runs and verify each `exports` entry point loads at the end. Catches the "incremental tsc skipped a file" failure mode that broke the initial `@polygonlabs/express` npm publish.

  See [`MIGRATION.md`](./MIGRATION.md) for migration patterns.

## 1.1.0

### Minor Changes

- cc31c39: Add `@polygonlabs/openapi-registry/error-schemas` subpath exporting the
  canonical Zod schemas for the standard error response shapes
  (`ErrorResponseSchema`, `ValidationErrorResponseSchema`,
  `ValidationErrorInfoSchema`, `ZodErrorTreeSchema`).

  These previously lived only inside `@polygonlabs/express/registry`, which
  forced schemas-only consumers to take a transitive dep on Express + pino +
  Sentry just to register the canonical 400 / 401 / 5xx response shapes in
  their OpenAPI spec. The schemas have zero Express-runtime imports — only
  `zod` and `@asteasolutions/zod-to-openapi` — so they belong with the
  registry primitives.

  Express 1.1.x's `@polygonlabs/express/registry` continues to re-export
  them unchanged for back-compat, so existing import paths keep working.
  New schemas-only packages should import from
  `@polygonlabs/openapi-registry/error-schemas` directly.

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
