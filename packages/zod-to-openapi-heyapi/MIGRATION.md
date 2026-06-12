# Migration Guide

## 1.3.0 → 2.0.0 (registration-based input-slot naming — breaking)

2.0.0 changes how the plugin resolves a route's
`request.{params, query, body, headers}` schema to the name the generated
client imports. 1.x matched the slot's schema instance against
`schemasFrom`'s named exports **by instance identity**. 2.0.0 reads the
**registration name** (the refId that `.openapi('Name')` /
`register('Name', schema)` attached to the instance the route holds) and
audits that an export exists under that name.

### Why

The identity lookup was unsound. openapi-ts loads the codegen config
through c12/jiti; under a custom export condition (e.g.
`NODE_OPTIONS='--conditions=@polygonlabs/source'` for build-free
monorepo codegen) the schemas package's `.ts` source is evaluated twice —
once in the config loader's module cache (the instances the registry
holds) and once natively (the instances the plugin's own
`await import(schemasFrom)` saw). Same source, same names, different
object identity: the lookup found nothing and **silently dropped every
codec input transformer** from the emitted client, which then sent
wire-invalid values (a `Date` as a locale string) while compiling clean.

Registration metadata travels with the instances the registry itself
hands the plugin, so resolution no longer consults a second module
evaluation at all. The plugin's dynamic import of `schemasFrom` survives
only as a string-membership audit over export names, which is immune to
the split by construction.

### Required: register codec-bearing input schemas

Any schema used in a route's `request` block that contains a codec must
now be registered, with the export name matching the registered name:

```ts
// before (1.x) — plain export, resolved by instance identity
export const BlockNumberPathParams = z.object({ blockNumber: Int64Codec });

// after (2.0) — registered, resolved by name
export const BlockNumberPathParams = z
  .object({ blockNumber: Int64Codec })
  .openapi('BlockNumberPathParams');
```

The route keeps using the export as before — `.openapi(...)` returns the
registered instance, so chaining at the export site is all it takes.
Unregistered codec-bearing slots **fail codegen** with an error listing
every offending `operation / request.<slot>` pair and this exact remedy,
so the migration is mechanical: run codegen, register and export what the
error names, regenerate the spec (registered schemas become named
components / `$ref`s), rerun codegen.

This reverses the 1.1.1 "you can drop `.openapi('Name')` on input
schemas" relaxation — that advice only worked because of the identity
lookup this release removes.

Codec-free behaviour is unchanged: anonymous inline request schemas
(`params: z.object({ id: z.uuid() })` written in the route) are still
skipped silently, and codec-free registered slots resolve by name just
like codec-bearing ones.

### Removed: misalignment warning

The 1.x `console.warn` for a refId-bearing slot that wasn't
identity-equal to the export is gone. That situation (e.g. the route
holds the post-`register()` clone while the export is the pre-`register`
original) now simply resolves by name — the generated client imports the
export under the registered name, which validates the same wire shape.
If the name isn't exported at all, the codegen-time audit fails with the
exact name to export.

## 1.2.0 → 1.3.0 (TransportError / ResponseValidationError discrimination — bug fix)

1.2.0's error-decoding wrapper had a hole: when an API returned a body
that didn't match any registered error schema, the `throwOnError: false`
path silently left wire-shape values in `result.error` even though the
type system claimed `result.error` was `z.output<typeof Schema>`. A
consumer reading `result.error.traceId` (typed `bigint` via `Int64Codec`)
would get a string at runtime. The `throwOnError: true` path also
didn't surface validation failures clearly — the original wire-shape
body re-threw, which caused similar runtime/type drift.

1.3.0 fixes this by emitting two new classes, `TransportError` and
`ResponseValidationError`, alongside the SDK wrappers, and **widening the
wrapper's static return type** so the runtime shape and the static
type stay in sync. The wrapper now sorts every error response into
one of three categories:

```ts
type Error = ${Op}Error | TransportError | ResponseValidationError;
```

`result.error`'s static type widens to that union (delivered by an
emitted `WrapErrors<TData, TError, ThrowOnError>` file-scope alias
that wraps each per-op return). Consumers narrow via emitted
type-predicate guards (`isTransportError` / `isResponseValidationError`) — no
`instanceof` at the call site:

```ts
import { isTransportError, isResponseValidationError } from '@my-org/api-client';

const { data, error } = await getX();
if (isTransportError(error)) {
  // Request never reached the API. error.cause is the native fetch
  // error: TypeError / AbortError / Node SystemError with .code.
} else if (isResponseValidationError(error)) {
  // Got an HTTP response, body didn't match any registered schema.
  // error.cause is the ZodError; error.body is the original wire body.
} else if (error) {
  // Typed ${Op}Error — codec runtime shapes intact.
}
```

The guards are emitted with `value is TransportError` / `value is
ResponseValidationError` type predicates, so each branch narrows `error` to the
right shape without further casts. They check a symbol-keyed marker
(`Symbol.for('@polygonlabs/zod-to-openapi-heyapi/is-transport-error')`,
likewise for response-validation) — symbol identity from `Symbol.for(...)` is
stable across realms, workers, iframes, and multiple bundle copies of
the generated client, which `instanceof` is not.

A union helper `isWrapperError(value): value is TransportError |
ResponseValidationError` is also emitted for "log any wrapper-emitted error
generically" call sites that don't care which category.

### Internals: how transport vs schema-mismatch is decided

The wrapper discriminates transport failures from schema-mismatch via
`err instanceof Error` — fetch's transport rejections (`TypeError`,
`AbortError`, Node `SystemError`) all extend the global `Error` in
the same realm as the wrapper's call site, while hey-api's wire-shape
error bodies are plain object literals. A `'stack' in err` duck-type
heuristic was tried and rejected: debug-mode servers (Express / Koa /
FastAPI) include stack traces in error JSON, which would be
mis-classified as TransportError and skip `parseAsync` entirely —
the exact failure mode this release sets out to fix.

### Required: handle the new error categories

Existing 1.2.0 consumers that did `if (result.error) { result.error.code }`
without narrowing will now get a TS error: `result.error.code` doesn't
exist on `TransportError` or `ResponseValidationError`. The fix is the three-branch
narrow above.

This is intentional — if you don't surface the unknown / transport cases
explicitly, your code silently broke on malformed responses under 1.2.0.
The TS error tells you exactly where to add handling.

For consumers using `throwOnError: true`, the same three categories
apply to the thrown value — same guards in the catch block.

### Optional: read the wire body when debugging

`ResponseValidationError.cause` is the `ZodError` from `parseAsync` (carries
`.issues`); `ResponseValidationError.body` is the original HTTP body the server
sent. Symmetric with `TransportError.cause` (native Error) — both
fields are one hop from the wrapper-error. When debugging schema
drift, log the full instance — `pino`, Sentry, and `util.inspect`
with `{ depth: Infinity }` walk the chain:

```ts
import { logError } from './logger';
if (isResponseValidationError(error)) {
  logError({ err: error, body: error.body });
}
```

For `TransportError`, `error.cause` is the native fetch error
directly, so the same logging pattern surfaces the underlying
`code: 'ECONNRESET'` or whatever the cause was.

### Why this design

Three alternatives I considered before settling on the discriminated
classes:

- **Throw on validation failure regardless of throwOnError**: kept the
  existing `result.error` shape but broke the `throwOnError: false`
  no-throw contract. Inconsistent semantics for the same underlying
  problem.
- **Add an optional `validationError` field to result**: required
  consumers to check both `result.error` and `result.validationError`,
  invited mis-handling. Network errors (which shouldn't run through
  parseAsync) had nowhere clean to live.
- **Single wrapper class for everything non-typed**: lumped
  network failures (request never reached the API) with schema
  mismatches (request reached the API, body didn't conform). Two
  fundamentally different failure modes that consumers usually want to
  handle differently.

The two-class split mirrors the boundary "did the request reach the
API at all" — clean separation, tag-based narrowing, no `instanceof`.

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

### Error response decoding (initial implementation, see 1.2.1 for the fix)

1.2.0 emitted `${opId}ErrorTransformer` and a wrapper that called it,
intending to make `result.error` carry the codec runtime shape declared
in `${Op}Error`. The implementation had a hole: `parseAsync` failures
on the `throwOnError: false` path were silently swallowed, leaving
wire-shape values in `result.error` and re-introducing the type/runtime
gap on malformed responses. **1.2.1 fixes this** — see the 1.2.0 → 1.2.1
section above. New consumers should target 1.2.1 directly.

Two minor wrapper-behaviour changes from 1.2.0 are still relevant:

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
