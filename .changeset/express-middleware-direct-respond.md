---
'@polygonlabs/express': major
---

The registry router's framework middleware now responds directly at the
detection site instead of routing through the global error handler via
`next(err)`. Three middlewares are affected:

- **Request validator** — on validation failure, responds 400 directly
  with the canonical `ValidationErrorResponse` shape (the wire shape
  that `@polygonlabs/openapi-registry`'s auto-inject declares for every
  validating route). Previously threw `BadRequest` to the global
  handler, which emitted the generic `ErrorResponse` shape — and that
  generic shape doesn't satisfy the declared `ValidationErrorResponse`
  schema (which requires `info` with the section-keyed tree). The new
  direct response closes the served-spec-vs-runtime-body drift.
- **Response validator** — on `z.encode` failure, logs at error level
  with the underlying `ZodError` (Sentry-visible, full chain on the log
  line) and responds 500 directly with `info.operationId`. The leaked
  ZodError-text-as-`message` bug is gone; the boundary author's safe
  message is what the client sees.
- **Auth middleware** — on auth failure, responds directly. An
  `HTTPError` from an auth handler is honoured (its statusCode and
  message reach the client unchanged); a non-HTTP throw defaults to 401
  with a generic message instead of leaking to a 500.

The shared `sendErrorResponse(res, status, message, info?)` helper is
the single source of truth for the framework's error wire shape, so
every middleware emits a body that matches the `ErrorResponseSchema`
the registry auto-injected for that status. The patched `res.json`
in the response validator does not re-encode error responses because
they don't pass through the patched function — direct calls bypass it.

The global `createErrorHandler` simplifies as a result: its only
inputs are now route-handler-thrown errors (HTTPError, plain Error,
or unhandled bubble-throughs). It logs non-HTTPError throws at error
level (single log entry per incident — nothing else has logged) and
responds. HTTPError throws are not logged: the team convention is
that anyone wrapping a downstream error in an HTTPError has already
logged the cause, so logging here would either double-log (convention
followed) or be redundant with the 4xx status itself being the
client's signal.

## Migration

For consumers:

- Routes that previously relied on the global handler's response shape
  for 400/401/500 will see the same shape they were getting (the
  helper emits the same body). The only difference is the source of
  truth.
- 5xx server-bug logs now appear at the detection site's middleware
  with `operationId` and the underlying error chain visible — Sentry
  fires there rather than at the global handler. Existing alerting
  doesn't need to change.
- Consumer `createErrorHandler` customisations no longer affect
  framework-middleware responses (they were always framework
  contracts; this just makes that boundary explicit). Customisations
  apply to route-handler-thrown errors as before.

The `peerDependency` on `@polygonlabs/openapi-registry` is bumped to
require the auto-inject-aware version; the major bump cascades from
that peer-dep change. The behaviour changes here are themselves
minor-shaped (no public API surface change beyond moving the
response-shape policy into framework middleware).
