---
'@polygonlabs/zod-to-openapi-heyapi': minor
---

Thread `TResponseStyle` through wrapper return types so the wrapper's
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
const data = await getX<true, 'data'>();          // flat TData
const maybe = await getX<false, 'data'>();        // TData | undefined
const fields = await getX<false>();               // { data, error, ... }
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
