---
'@polygonlabs/zod-to-openapi-heyapi': minor
---

Fix: error-decoding wrapper now wraps non-conforming responses into
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
