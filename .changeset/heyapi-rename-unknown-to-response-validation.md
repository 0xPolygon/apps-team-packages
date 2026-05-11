---
'@polygonlabs/zod-to-openapi-heyapi': patch
---

Rename `UnknownError` → `ResponseValidationError`.

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
