---
"@polygonlabs/zod-to-openapi-heyapi": major
---

Input-slot schema names now resolve from registration metadata (`.openapi('Name')` / `register('Name', schema)`) instead of instance-identity matching against the schemas module's exports, fixing source-condition (build-free) codegen and making unregistered codec-bearing request slots fail codegen loudly.

## Breaking: codec-bearing input schemas must be registered

A schema used in a route's `request.{params, query, body, headers}` that contains a codec must be registered, with its export name matching the registered name:

```ts
export const BlockNumberPathParams = z
  .object({ blockNumber: Int64Codec })
  .openapi('BlockNumberPathParams');
```

Codegen now fails for unregistered codec-bearing slots, listing every offending operation/slot pair and the remedy. Codec-free anonymous inline request schemas are still skipped silently, exactly as before. Regenerating the spec after registering schemas turns those params/bodies into named components/`$ref`s — an expected one-time spec diff.

## Why

The 1.x identity lookup was unsound under split module evaluation: openapi-ts loads the codegen config through c12/jiti, and under a custom export condition (e.g. `NODE_OPTIONS='--conditions=@polygonlabs/source'`) the schemas package is evaluated twice — the registry's instances in the config loader's cache, the plugin's `await import(schemasFrom)` natively. Identity matching found nothing and silently dropped every codec input transformer, emitting a client that sent wire-invalid values (a `Date` as a locale string) while compiling clean.

Registration names travel with the instances the registry itself holds, so resolution is mode-independent by construction. The plugin's dynamic import of `schemasFrom` survives only as a string-membership audit verifying each emitted name (response and input alike) exists as a Zod-shaped named export.

See `MIGRATION.md` for the full 1.3.0 → 2.0.0 guide.
