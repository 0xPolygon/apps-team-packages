# Migration Guide

## 1.1.0 → 1.1.1 (input-side codec encoding)

This release adds input-side codec encoding to symmetrise the codec
round-trip. It also tightens the plugin's relationship with
`@hey-api/sdk` — both for correctness and to give the plugin a single
canonical SDK function per operation.

### Required: update `@hey-api/sdk` plugin config

Both `transformer: true` and `includeInEntry: false` are now required on
`@hey-api/sdk`. Update your `openapi-ts.config.ts` plugins entry:

```ts
// before
{ name: '@hey-api/sdk' }
// or
{ name: '@hey-api/sdk', transformer: true }

// after
{ name: '@hey-api/sdk', transformer: true, includeInEntry: false }
```

The plugin's pre-flight check throws a clear codegen-time error
spelling out the exact before/after config if either key is wrong, so
misconfiguration surfaces immediately rather than as a duplicate-export
TS error or a silent type/runtime divergence in the downstream
consumer's typecheck.

Why each is required:

- **`transformer: true`** — wires our `${opId}Transformer` symbols into
  the SDK function's `responseTransformer` slot. Without it, codec
  response decode silently doesn't run; callers receive wire-shaped
  data while the type system promises the runtime shape.
- **`includeInEntry: false`** — the plugin emits a wrapper per
  operation under the same name as the SDK plugin's emission. Without
  this, both land in the auto-generated `index.ts` and TypeScript
  fails the duplicate export.

### Optional: simplify input schema declarations

Input schemas (`request.{params, query, body}`) no longer need
`.openapi('Name')` chains for the plugin to recognise them. The plugin
resolves slot names by identity-matching the route's ZodType against
`schemasFrom`'s named exports.

```ts
// before — chained .openapi on the export
export const BlockNumberPathParams = z
  .object({ blockNumber: Int64Codec })
  .openapi('BlockNumberPathParams');

// after — plain export works
export const BlockNumberPathParams = z.object({ blockNumber: Int64Codec });
```

Existing chains keep working — this is purely a "you can drop noise"
change, not a breaking one. Response schemas still need
`.openapi('Name')` because `OpenApiGeneratorV3` uses it to emit `$ref`
in the spec.

### Caller-side: optional slots can be omitted

Routes whose `${Op}Data` declares a slot optional now emit a matching
optional slot in `${Op}Input` and an optional `options?:` parameter
on the wrapper. So a route with only an optional query schema accepts
a no-arg call:

```ts
// before
await listMessages({ query: {} });

// after
await listMessages();
```

This is purely a relaxation — `listMessages({ query: {} })` still
typechecks and behaves the same.

## 1.0.0 → 1.1.0

The codegen-time audit narrowed from "every name in
`components.schemas` must have a matching named export" to "every name
referenced via `$ref` from a route response must have a matching named
export." Schemas registered as path / query parameters or request
bodies — but not referenced from any response — are silently skipped.

No consumer-side action required. The narrower audit is strictly more
permissive: setups that passed under 1.0.0 keep passing; setups that
failed audit on parameter-only schemas under 1.0.0 (e.g. routes using
`registry.registerParameter('network', …)` without exporting a Zod
`network`) now pass.

## 1.0.0

Initial release.
