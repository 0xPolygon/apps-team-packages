# Migration Guide

## 1.1.1 → 1.2.0 (`defineRegistryClientConfig` + codec-aware tanstack factories)

This release adds a `defineRegistryClientConfig` factory and a
`tanstackReactQuery: true` option that composes with the upstream
`@hey-api/openapi-ts` `@tanstack/react-query` plugin. Both are
strictly additive — `registryPlugin` keeps working unchanged — so
no breaking change to migrate around. The recommended consumer
config gets meaningfully shorter and a new optional peer dep
appears. Two opt-in steps below.

### Recommended: switch to `defineRegistryClientConfig`

`defineRegistryClientConfig` is the canonical entry point. It
returns a complete openapi-ts `UserConfig` with the plugin order,
SDK flags (`transformer: true`, `includeInEntry: false`), and the
resolution-fragile passthroughs (`$`, `OpenApiGeneratorV3`) all
wired internally. The full consumer config collapses to:

```ts
// before — six lines of plugins, all of them load-bearing
import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { $, defineConfig } from '@hey-api/openapi-ts';
import { registryPlugin } from '@polygonlabs/zod-to-openapi-heyapi';
import { myRegistry } from './schemas/registry';

export default defineConfig({
  input: './openapi.json',
  output: { path: './src/generated', clean: true },
  plugins: [
    (await registryPlugin({
      registry: myRegistry,
      schemasFrom: '@my-org/api-schemas',
      generatorClass: OpenApiGeneratorV3,
      $
    })) as never,
    '@hey-api/typescript',
    '@hey-api/client-fetch',
    { name: '@hey-api/sdk', transformer: true, includeInEntry: false }
  ]
});

// after — only the per-project knobs left at the call site
import { defineRegistryClientConfig } from '@polygonlabs/zod-to-openapi-heyapi';
import { myRegistry } from './schemas/registry';

export default await defineRegistryClientConfig({
  registry: myRegistry,
  schemasFrom: '@my-org/api-schemas',
  input: './openapi.json',
  output: { path: './src/generated', clean: true }
});
```

The `as never` cast and the imports of `$` / `OpenApiGeneratorV3` go
away. The `@hey-api/sdk` plugin entry's `transformer: true` and
`includeInEntry: false` flags go away (the factory installs them).
The consumer keeps full control of `input`, `output`, `registry`,
`schemasFrom`, and (new) `tanstackReactQuery` — everything else is
locked-in by the factory so the order can't drift between
generators.

`registryPlugin` keeps working as a public export for advanced users
who need to hand-wire the openapi-ts plugin list (e.g. interleaving
other plugins, customising sdk flags). New code should prefer the
factory.

### Optional: enable codec-aware tanstack factories

Set `tanstackReactQuery: true` on the factory if your consumer uses
`@tanstack/react-query`:

```ts
export default await defineRegistryClientConfig({
  registry: myRegistry,
  schemasFrom: '@my-org/api-schemas',
  input: './openapi.json',
  output: { path: './src/generated', clean: true },
  tanstackReactQuery: true
});
```

This installs the upstream `@hey-api/openapi-ts`
`@tanstack/react-query` plugin alongside the registry plugin, with a
parser-level `parser.hooks.operations.isQuery` hook that returns
`false` for codec op ids. The split:

- **Codec ops** (any op whose `request.{params, query, body, headers}`
  is a registered Zod schema) — factories come from this plugin in
  `registry-validator.gen.ts`. Typed against `${Op}Input` (codec
  runtime shapes — `bigint`, `Date`); codec slots pre-encoded into
  the queryKey via sync `z.encode(Schema, value)` so the default
  `JSON.stringify`-based queryKey hash stays stable for `bigint`
  inputs without a custom `queryKeyHashFn` on the consumer's
  QueryClient.
- **Non-codec ops** — factories come from the upstream plugin in
  `@tanstack/react-query.gen.ts`, unchanged. Standard wire-shape
  `Options<${Op}Data>` typing.

Both halves use the same names (`${opId}Options` / `${opId}QueryKey`),
so the consumer call site sees one naming scheme. The two emission
files don't double-emit any operation — the parser hook tells the
upstream plugin to skip codec ops.

`@tanstack/react-query` becomes an **optional peer dependency** —
only required when this flag is on. Consumers that don't use the
option pay no cost.

#### Caller-side ergonomics

```ts
// before — codec ops couldn't go through the factory; consumers had
// to drop to the SDK function inside an inline queryFn to keep bigint
// types, losing the typed queryKey and Errors generic
const blockMetadata = useQuery({
  queryKey: ['getBlockMetadata', BigInt(blockHeight)],
  queryFn: async () => {
    const r = await getBlockMetadata({ path: { blockNumber: BigInt(blockHeight) } });
    if (r.error) throw r.error;
    return r.data;
  }
});

// after — canonical factory accepts the bigint directly; queryKey,
// queryFn, and error generic all wired
const blockMetadata = useQuery(
  getBlockMetadataOptions({ path: { blockNumber: BigInt(blockHeight) } })
);
```

If you previously configured a bigint-aware `queryKeyHashFn` on your
`QueryClient` to work around `JSON.stringify`'s bigint refusal, you
can remove it — the factory's pre-encoded queryKey contains
wire-shape strings, not the codec runtime values.

### Bug fix (no consumer action required): error response codec decoding

Operations that declare error response schemas now emit an
`${opId}ErrorTransformer` and a real SDK wrapper that calls it, so the
runtime value of `result.error` matches the codec runtime types the
plugin already emits in `${Op}Error`. Previously the `${Op}Error`
type claimed `z.output<typeof Schema>` (codec runtime shapes —
`bigint`, `Date`, …) but `client-fetch` only runs response
transformers on 2xx, so the runtime arrived wire-shape and silently
diverged from the type. Both `throwOnError: false` (decoded in place
on `result.error`) and `throwOnError: true` (caught, decoded,
re-thrown) paths are covered.

Two minor wrapper-behaviour changes worth flagging — neither
requires consumer code changes, but they're observable:

- `getX === getX2` identity equality no longer holds for any op
  with declared error schemas (the wrapper is a real function, not a
  `const X = X2` re-bind). Anyone introspecting `===` against the SDK
  function rather than calling it would notice.
- The pass-through wrapper for ops with no input AND no error
  schemas is now a typed arrow `async (options) => sdkFn(options)`
  rather than a re-bind, so `wrapperFn.name === '${opId}'` (was
  `'${opId}2'` from hey-api's auto-alias). Telemetry / logging that
  introspects the canonical operation name now reports it correctly.

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
