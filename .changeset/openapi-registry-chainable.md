---
'@polygonlabs/openapi-registry': major
---

Replace the asserts-based API with chainable returns; add `OperationsOf<F>` and `SchemesOf<F>` helpers.

## Breaking changes

`registerPath` and `registerSecurityScheme` now return a narrower `TypedRegistry` instead of asserting `this is X`. Chain registrations to keep the type-level narrow:

```ts
// before
const registry: TypedRegistry = new TypedRegistry();
registry.registerPath({ operationId: 'a', /* … */ });

// after
const registry = new TypedRegistry()
  .registerPath({ operationId: 'a', /* … */ });
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
const addRoutes = <Ops, Schemes>(r: TypedRegistry<Ops, Schemes>) =>
  r.registerPath(/* … */);
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
- **`@polygonlabs/apps-team-lint`'s `polygon/no-discarded-chain`** rule (shipped in the same release wave) catches partial discards at lint time — type-aware, only fires on real `TypedRegistry` receivers. Enabled at `error` in the `typescript()` preset, so consuming repos pick it up automatically when they update.

See README "The one rule".

## Build hygiene

Both `@polygonlabs/openapi-registry` and `@polygonlabs/express` builds now clean `dist/` + `*.tsbuildinfo` before `tsc` runs and verify each `exports` entry point loads at the end. Catches the "incremental tsc skipped a file" failure mode that broke the initial `@polygonlabs/express` npm publish.

See [`MIGRATION.md`](./MIGRATION.md) for migration patterns.
