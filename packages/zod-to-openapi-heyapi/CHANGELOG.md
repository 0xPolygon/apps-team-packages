# @polygonlabs/zod-to-openapi-heyapi

## 2.0.2

### Patch Changes

- [#73](https://github.com/0xPolygon/apps-team-packages/pull/73) [`006cf08`](https://github.com/0xPolygon/apps-team-packages/commit/006cf081e794bb156cee0f37fabc450c5b03e7c5) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Ship the LICENSE file inside the published npm package

  The previous release added the Apache-2.0 license at the repo root and
  declared it in package.json, but npm only auto-includes a LICENSE file
  in the packed tarball when it lives in the same directory as the
  package's own package.json. The license metadata was correct but the
  actual license text was missing from the published package — this adds
  it.

## 2.0.1

### Patch Changes

- [#71](https://github.com/0xPolygon/apps-team-packages/pull/71) [`aa81b1a`](https://github.com/0xPolygon/apps-team-packages/commit/aa81b1a73e0b4711d195c12e12120f5f67191305) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Add Apache-2.0 license: the package now declares `"license": "Apache-2.0"` in its `package.json`, and the repository carries the full Apache License 2.0 text. Previously no license was declared.

## 2.0.0

### Major Changes

- d2a2e48: Input-slot schema names now resolve from registration metadata (`.openapi('Name')` / `register('Name', schema)`) instead of instance-identity matching against the schemas module's exports, fixing source-condition (build-free) codegen and making unregistered codec-bearing request slots fail codegen loudly.

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

## 1.3.0

### Minor Changes

- f7e1148: Complete the auto-generated `index.ts` as the canonical consumer
  surface.

  `defineRegistryClientConfig` now sets `includeInEntry: true` on
  `@hey-api/client-fetch` (so the singleton `client` reaches the
  auto-barrel) and on `@tanstack/react-query` (so non-codec ops'
  `${Op}Options` / `${Op}QueryKey` factories and codec ops'
  `${Op}Mutation` factories reach it too). The upstream tanstack
  plugin's colliding `QueryKey` alias is suppressed via a predicate so
  this plugin's canonical `QueryKey<TOptions>` is the only one in the
  entry.

  Before this change, consumer packages wiring up their public surface
  had to hand-roll re-exports from `client.gen.ts` and
  `@tanstack/react-query.gen.ts` to fill the gap — encoding internal
  codegen file layout in the consumer's hand-written barrel. The split
  across multiple `*.gen.ts` files (one canonical name per op id, but
  across files chosen by codec status / HTTP verb) is non-intuitive
  and shouldn't be something the consumer has to understand.

  The result: a publishable client package's hand-written barrel can
  re-export from `./generated/index.js` without ever naming a
  `*.gen.ts` path. See `apps-team-ts-template/packages/example-client/src/index.ts`
  for the reference shape.

- fa6f86a: New entry: `@polygonlabs/zod-to-openapi-heyapi/errors`.

  Small structural helpers for code paths that work across multiple
  generated clients (logging adapters, generic error-reporting
  middleware). Surface:
  - `isTransportError`, `isUnknownError`, `isWrapperError` — same
    type-predicate guards the codegen emits per-client, but importable
    from the plugin itself for cross-client / no-import-cycle code.
  - `TransportError`, `UnknownError` — structural `interface`s matching
    the codegen-emitted classes.
  - `categorizeApiError(value)` — returns a discriminated union
    (`transport` / `unknown` / `native-error` / `other`).
    Deliberately no `'typed'` branch: the wrapper return already encodes
    the typed `${Op}Error` union statically, so consumers with the typed
    return in scope narrow with the codegen-emitted predicates directly.
    The `'other'` bucket carries values as `unknown` for consumer code
    to narrow with per-op types — never a magic-string convention here.
  - `getApiErrorMessage(value, fallback?)` — returns `error.message`
    for `Error` instances, fallback otherwise.
  - `TRANSPORT_ERROR_MARKER`, `UNKNOWN_ERROR_MARKER` — symbol-key
    constants for power users.

  Import via the published subpath (`/errors`); the plugin's main entry
  stays codegen-only.

  ```ts
  import { categorizeApiError, isTransportError } from '@polygonlabs/zod-to-openapi-heyapi/errors';

  const category = categorizeApiError(error);
  switch (category.kind) {
    case 'transport':
      /* category.error: TransportError */ break;
    case 'unknown':
      /* category.error: UnknownError   */ break;
    case 'native-error':
      /* category.error: Error          */ break;
    case 'other':
      /* category.error: unknown        */ break;
  }
  ```

  Same symbol-keyed markers the codegen-emitted guards check (the markers
  come from the global `Symbol.for(...)` registry, so they're
  identity-stable across realms / module copies / iframes / workers).

- 275a9e5: Thread `TResponseStyle` through wrapper return types so the wrapper's
  static type tracks hey-api's `responseStyle` runtime in both modes.

  `WrapErrors<TData, TError, ThrowOnError, TResponseStyle = 'fields'>`
  takes a fourth `TResponseStyle` generic that conditionally produces
  hey-api's `'fields'` (`{ data, error, request, response }`) or
  `'data'` (flat `TData` / `TData | undefined`) return shape. Every
  emitted wrapper signature — error-widening AND pass-through —
  carries the same fourth generic. Pass-through ops use a sibling alias
  `WrapPassThrough<TData, ThrowOnError, TResponseStyle>` with the same
  conditional structure minus the `TError` generic and the
  wrapper-error union (pass-throughs don't wrap errors at runtime).

  Pinning the generic at the call site narrows the static return to
  match whatever runtime style the client / call options select:

  ```ts
  client.setConfig({ responseStyle: 'data' });
  const data = await getX<true, 'data'>(); // flat TData
  const maybe = await getX<false, 'data'>(); // TData | undefined
  const fields = await getX<false>(); // { data, error, ... }
  ```

  Runtime behaviour stays in step. The wrapper's error-wrapping gate
  switched its 'fields'-style discriminator to
  `'request' in result && 'response' in result` — hey-api's runtime
  omits the `data` / `error` keys on the unused half of the envelope,
  but always emits `request` and `response` in 'fields' mode and never
  in 'data' mode. So:
  - `'fields'` + `throwOnError: false`: the envelope is present;
    `result.error` is wrapped in-place as before.
  - `'fields'` + `throwOnError: true`: the SDK throws; the wrapper's
    catch block wraps and rethrows as before.
  - `'data'` + `throwOnError: false`: hey-api returns the flat payload
    on success or `undefined` on error; the discriminator skips the
    wrap (no envelope to mutate).
  - `'data'` + `throwOnError: true`: hey-api throws; the wrapper's
    catch block wraps and rethrows. Consumers catch and narrow with
    the codegen-emitted `is*Error` predicates.

  Polish from the same review pass:
  - Tighten the wrapper's error-bearing entry check from
    `errorBearing.error != null` to
    `typeof errorBearing.error === 'object' && errorBearing.error !== null`,
    defending against the hostile `error: 0` / `error: ''` / `error: false`
    cases that would otherwise fall through to `parseAsync(<primitive>)`
    and mis-classify as a `ResponseValidationError`.
  - Drop the redundant `{ cause }` option from `super(message, …)` in
    emitted wrapper-error class constructors. The class declares
    `readonly cause: <T>` and assigns it explicitly via
    `this.cause = cause` — the super-side option was assigning the
    same value twice for no observable benefit.
  - Add data-field parity assertions in `types.test.ts` for the
    error-widening wrappers (createOrFetchResource, createOrder,
    getErrorsOnly) against the raw SDK functions exposed via
    `_test-internals.ts`. The previous coverage pinned `['error']` only;
    this pins `['data'] === SDK['data']` so a regression that widens
    the data branch (e.g., re-emits as unknown) is caught at typecheck.

  Coverage matrix:
  - `types.test.ts`: complete style × throwOnError matrix for both
    `WrapErrors` (error-widening wrappers) and `WrapPassThrough`
    (pass-throughs), plus data-shape parity against the raw SDK return.
  - `api-errors.test.ts`: new `'data'`-style runtime suite covering
    success, transport, response-validation, and typed-error categories
    for both `throwOnError` modes (errors swallow to `undefined` on
    no-throw).
  - `hooks.browser.test.tsx`: `useMutation` `'data'`-mode coverage of
    the same four categories, plus the no-throw `'data'` swallowed-
    undefined path. Query side stays unchanged — codec-aware queryFn
    calls the raw SDK with `throwOnError: true` by design.

  Also ignores `test/__screenshots__/` — vitest browser-mode artifact
  not deterministic across machines.

- d2b9a29: Fix: error-decoding wrapper now wraps non-conforming responses into
  typed discriminator classes instead of leaking wire-shape values into
  `result.error` (1.2.0 silently swallowed `parseAsync` failures on
  the `throwOnError: false` path) or throwing opaque rejections (1.2.0's
  `throwOnError: true` path re-threw the original wire-shape body).

  The plugin emits two classes alongside the SDK wrappers:
  - **`TransportError`** — request never produced an HTTP response.
    `cause` is the native fetch error (`TypeError`, `AbortError`, Node
    `SystemError` carrying `.code === 'ECONNRESET'` / `'ETIMEDOUT'` /
    `'ENOTFOUND'`). `parseAsync` is **not** run against transport
    failures — there is no body to validate, so wrapping in a
    schema-mismatch error would be wrong.
  - **`UnknownError`** — request produced an HTTP body, but the body
    did not match any registered error schema. `cause` is the
    `ZodError` from `parseAsync`; `body: unknown` is the original wire
    body for debugging schema drift. Both fields are one hop from the
    wrapper-error — symmetric with `TransportError.cause`.

  Both classes are tagged `@internal` in JSDoc — codegen-emitted, not
  consumer-instantiable.

  Wrapper internals discriminate transport from schema-mismatch via
  `err instanceof Error` directly. Fetch's transport rejections
  (`TypeError`, `AbortError`, Node `SystemError`) all extend the global
  `Error` in the wrapper's realm; hey-api's wire-shape error bodies are
  plain object literals.

  Consumer narrowing — three branches via emitted type-predicate
  guards, no `instanceof`:

  ```ts
  import { isTransportError, isUnknownError } from '@my-org/api-client';

  const { error } = await getX();
  if (isTransportError(error)) {
    // network / abort / DNS — error.cause is the native Error
  } else if (isUnknownError(error)) {
    // schema mismatch — error.cause is the ZodError, error.body is the wire body
  } else if (error) {
    // typed `${Op}Error`
  }
  ```

  A third helper `isWrapperError(value): value is TransportError |
UnknownError` is also emitted, for "log any wrapper-emitted error
  generically" call sites.

  The guards check a symbol-keyed marker (`Symbol.for(...)`), stable
  across realms, workers, iframes, and multiple bundle copies of the
  generated client. The same marker key (`@polygonlabs/zod-to-openapi-heyapi/is-{transport,unknown}-error`)
  is used by every generated client, so two separately-generated clients
  in the same process produce mutually-narrowable instances.

  `result.error`'s **static** type now widens to
  `${Op}Error | TransportError | UnknownError | undefined` (delivered
  by an emitted file-scope `WrapErrors<TData, TError, ThrowOnError>`
  type alias that wraps each per-op return). Existing 1.2.0 callers
  written against `result.error.<typed-field>` without narrowing will
  get a TS error — that's the feature, since silent runtime divergence
  on malformed responses is the bug this release fixes.

  The same shape applies to `throwOnError: true`: the thrown value is
  `${Op}Error | TransportError | UnknownError`, and the consumer's
  `catch` block narrows the same way.

  The codec contract for `${Op}Error` stays narrow at the type level
  (`z.output<typeof Schema>`) so consumers reading `result.error.<field>`
  after the typed-error branch always see the codec runtime shape —
  never a wire-shape leak, never a `ZodError`. Type and runtime are
  kept in sync.

### Patch Changes

- 7ed8705: Rename `UnknownError` → `ResponseValidationError`.

  The old name described the consumer's perception ("we don't know what
  this is"). The class is structurally always
  `new ResponseValidationError(zodError, wireBody)` — `cause` is
  `ZodError`, never anything else; `body` is the wire payload that
  failed parse. Naming it after the layer (response-side validation)
  is symmetric with `TransportError` (transport-layer failure) and
  disambiguates from request-side `z.encode` failures the plugin also
  runs.

  Mechanical rename surface:
  - `UnknownError` → `ResponseValidationError`
  - Marker key: `@polygonlabs/zod-to-openapi-heyapi/is-unknown-error`
    → `@polygonlabs/zod-to-openapi-heyapi/is-response-validation-error`
  - Guard: `isUnknownError` → `isResponseValidationError`
  - `UNKNOWN_ERROR_MARKER` → `RESPONSE_VALIDATION_ERROR_MARKER` in the
    `/errors` subpath
  - `categorizeApiError` discriminator: `kind: 'unknown'`
    → `kind: 'response-validation'`
  - `isWrapperError` and its predicate union update accordingly

  Also: the structural `ResponseValidationError.cause` type in the
  `/errors` subpath now claims the full `ZodError` (not the prior
  asymmetric `{ issues }` shape), so cross-client consumers reach
  `.format()` / `.flatten()` / `.issues` without a cast. `zod` is
  already a peer dependency (every generated client imports it for
  `parseAsync`); the import is type-only — the `/errors` module has
  no runtime dependency on `zod`.

  Marked as `patch` because the wrapper-error surface introduced in the
  same release (1.3.0) is still pre-release; there are no on-npm
  consumers to break.

## 1.2.0

### Minor Changes

- d030539: Add a `defineRegistryClientConfig` factory and a codec-aware TanStack
  Query option that composes with the upstream
  `@tanstack/react-query` plugin instead of replacing it.

  ## `defineRegistryClientConfig`

  The canonical entry point for generating clients with this plugin.
  Returns a complete openapi-ts UserConfig with the plugin order, sdk
  flags (`transformer: true`, `includeInEntry: false`), and
  resolution-fragile passthroughs (`$`, `OpenApiGeneratorV3`) all wired
  up internally:

  ```ts
  import { defineRegistryClientConfig } from '@polygonlabs/zod-to-openapi-heyapi';
  import { myRegistry } from './schemas/registry';

  export default await defineRegistryClientConfig({
    registry: myRegistry,
    schemasFrom: '@my-org/api-schemas',
    input: './openapi.json',
    output: './src/generated'
  });
  ```

  Strictly additive — `registryPlugin` keeps working for advanced users
  who need to compose the plugin list by hand.

  ## `tanstackReactQuery: true`

  Pass on `defineRegistryClientConfig` to wire the upstream
  `@tanstack/react-query` plugin into the config alongside this plugin's
  codec-aware factory emission. The two halves split cleanly:
  - **Codec ops** (operations with a registered input schema) get
    `${opId}Options` / `${opId}QueryKey` from this plugin, typed against
    `${Op}Input` (runtime shapes). Codec slots pre-encode into the
    queryKey synchronously, so the default `JSON.stringify`-based
    queryKey hash stays stable for `bigint` / `Date` slot values without
    consumers having to configure `queryKeyHashFn`.
  - **Non-codec ops** get the standard wire-shape factories from the
    upstream `@tanstack/react-query` plugin, unchanged.

  Both halves use the same names; consumers see one naming scheme. The
  factory installs a parser-level `isQuery` hook returning `false` for
  codec op ids so the upstream plugin skips them — without that gating
  both plugins would emit the same names.

  The queryFn calls the raw SDK function (not the wrapper) since
  `queryKey[0]` already carries the wire-shape values; re-encoding
  through the wrapper would corrupt them. Error generics use the
  operation's `${Op}Error` union when one exists, falling back to
  TanStack's `DefaultError` otherwise.

  `@tanstack/react-query` becomes an optional peer dependency — only
  install it when the flag is on.

  ## Error response codec decoding

  Operations that declare error response schemas now emit an
  `${opId}ErrorTransformer` and a real SDK wrapper (the previous re-bind
  form is reserved for ops with no input schemas AND no error schemas).
  The wrapper decodes `result.error` through `parseAsync` on the
  `throwOnError: false` path and re-throws the decoded shape on the
  `throwOnError: true` path, so the runtime value matches the codec
  runtime types the plugin emits in `${Op}Error`. Previously the
  `${Op}Error` types claimed `z.output<typeof Schema>` (codec runtime
  shapes — `bigint`, `Date`, …) but `client-fetch` only runs response
  transformers on 2xx, so the runtime arrived wire-shape and silently
  diverged from the type. The wrapper closes that gap.

  Two minor wrapper-behaviour changes worth flagging:
  - `getX === getX2` identity equality now returns `false` for any op
    with declared error schemas (the wrapper is a real function, not a
    re-bind). Anyone introspecting `===` against the SDK function rather
    than calling it breaks.
  - The wrapper can throw on the input-encoding step OR the error-decoding
    step regardless of `throwOnError`, same as the existing input-encoding
    step has always behaved. On the `throwOnError: false` path, parse
    failures on the error body are swallowed (wire shape passes through
    unchanged) so non-throwing callers stay non-throwing on malformed
    responses; on the `throwOnError: true` path, a parse failure
    re-throws the original wire-shape body so network-level errors that
    don't match the registered schema reach the caller as-is.

## 1.1.1

### Patch Changes

- 8452fe8: Fix codec round-trip on the request side and own the public SDK surface end-to-end.

  The plugin already decoded codec-typed responses on receipt (`Int64Codec` wire string → `bigint`, `IsoDateCodec` wire string → `Date`). Outgoing requests didn't get the symmetric treatment, so callers had to pass wire-shaped values for path / query / body parameters — and worse, `IsoDateCodec` on a path or query parameter didn't round-trip at all (`String(date)` is the locale string, not ISO 8601, and the server rejects it). This release closes that gap:
  - For routes whose `request.{params, query, body}` ZodObject is exported from `schemasFrom`, the plugin now emits a runtime-shaped `${Op}Input` type and a per-op transformer that runs `z.encode(schema, value)` before the request is serialised. Callers pass `bigint` / `Date` / etc.; the wire format goes onto the URL or into the body.
  - Input slot names are resolved by **identity lookup** against `schemasFrom`'s named exports — no `.openapi('Name')` chain or `register()` call is required for inputs. Use the same instance in the route as you export. (Response schemas still need `.openapi('Name')` because the OpenAPI generator uses it to lift them into `components.schemas` and emit `$ref`.)
  - Per-slot optionality is mirrored from hey-api's `${Op}Data`. A route whose query schema has only optional fields emits `query?: ...` in `${Op}Input` and `options?:` on the wrapper, so `listMessages()` with no args works. Routes with a required path slot still demand `(options: { path: { ... } })` at the call site.
  - The plugin emits one canonical SDK function per operation — codec-bearing ops get the encoding wrapper, everything else gets a zero-overhead re-binding of the upstream `@hey-api/sdk` emission. Both flow through `registry-validator.gen.ts` so the consumer's import surface is uniform and unambiguous.
  - The codegen-time audit covers input schemas as well as responses — input slots whose ZodType isn't a named export of `schemasFrom` silently skip encoding (anonymous inline params), and named exports are guaranteed-importable by construction.

  Required setup change: pass `transformer: true, includeInEntry: false` on the `@hey-api/sdk` plugin entry. Both are non-negotiable now — the registry plugin owns the public SDK surface (so `@hey-api/sdk`'s same-named raw functions must stay out of the auto-generated entry barrel) and wires its `${opId}Transformer` symbols via the SDK plugin's `transformer` hook (so without it response decode silently doesn't run). The plugin throws a clear, actionable error at codegen time if either is misconfigured, with the exact before/after config to write — so misconfiguration surfaces immediately rather than as a confusing duplicate-export TS error or a silent type/runtime divergence downstream.

  Headers are out of scope this iteration; documented as a follow-up in the README.

## 1.1.0

### Minor Changes

- 20d74b0: Narrow the codegen-time audit to schemas actually `$ref`d from a route response.

  The previous audit walked every entry under `components.schemas` and demanded a matching named export from `schemasFrom` for each. That over-approximated the import set the plugin actually emits — the generated client only imports response schemas, never request bodies, internal building blocks, or registered path / query parameters. zod-to-openapi v8's `OpenApiGeneratorV3` lifts parameter schemas into both `components.parameters` and `components.schemas`, so a route registered with `registry.registerParameter('network', ...)` would trip the audit demanding a Zod export named `network` even though the plugin never imports it.

  The audit now walks `paths.*.responses.*.content.*.schema.$ref` to determine which schemas need exports — exactly the set the plugin emits `import { Name } from '<schemasFrom>'` for. Parameter-only schemas, request body schemas, and unreferenced building blocks are silently ignored.

  The audit's other guarantees are unchanged: response schemas must be named exports under their registered names, and the export must be a Zod schema (duck-typed). Aggregated multi-issue errors still report every problem in one pass.

  Other improvements:
  - Sharper `ERR_MODULE_NOT_FOUND` error message when `await import(schemasFrom)` fails: explicitly calls out the most common causes (package not installed, custom export condition not active, relative path passed) so the developer doesn't have to guess.
  - README rewrite covering the new audit semantics, the cross-package vs. same-package distinction for `schemasFrom` (only `#imports` aliases work for same-package; cross-package uses the package name), the `.openapi()` chaining caveat for codecs imported from another package, the DOM-globals / `undici-types` workaround for Node consumers, the `@hey-api/client-fetch` deprecation FAQ (don't install separately — it's vendored into `@hey-api/openapi-ts`'s output), the `as never` cast explanation, the `.gitattributes` recommendation for committed generated code, the `sonar-project.properties` exclusions for static-analysis tooling, and a migration section covering `*Schema`-suffixed exports and the move from orval / openapi-typescript / `@hey-api/zod`.
  - Drop `@hey-api/client-fetch` from the plugin's `devDependencies` — the generated fixtures vendor the fetch client locally, so the explicit dep was unused.

## 1.0.0

### Major Changes

- 5a1c428: Initial release of `@polygonlabs/zod-to-openapi-heyapi`: a `@hey-api/openapi-ts` plugin that sources Zod schemas — including codecs — from a `@asteasolutions/zod-to-openapi` `OpenAPIRegistry` rather than regenerating them from the spec.

  Generated clients import the actual Zod schemas, gaining two things the standard `@hey-api/typescript` plugin can't provide:
  - **Codec-correct response types.** Each operation's response is emitted as `z.output<typeof Schema>`, so codec output types reach the caller. A `z.codec(z.string(), z.bigint(), …)` field is typed as `bigint` (the runtime value) instead of `string` (the wire format).
  - **Per-operation transformer functions** that call `Schema.parseAsync(data)`. `@hey-api/client-fetch` wires these as `responseTransformer`, so codec decode (`"1500.50"` → `1500n`, ISO string → `Date`, …) runs automatically before the value reaches the caller.

  The plugin works for every Zod construct `z.infer` supports — tuples, intersections, discriminated unions, lazy/recursive types, dates, sets/maps, defaults, branded types — by delegating to TypeScript's own resolution of Zod's type machinery rather than re-implementing it.
