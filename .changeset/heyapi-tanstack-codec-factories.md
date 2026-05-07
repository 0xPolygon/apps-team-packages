---
'@polygonlabs/zod-to-openapi-heyapi': minor
---

Add a `defineRegistryClientConfig` factory and a codec-aware TanStack
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
