---
'@polygonlabs/openapi-registry': minor
---

`TypedRegistry.registerPath` now auto-injects the standard framework-emitted
error responses based on what each route declares, so route authors don't
have to remember to add them by hand.

Inference rules:

- **400** with `ValidationErrorResponseSchema` is added when the route
  declares any of `request.params`, `request.query`, `request.body`, or
  `request.headers`. This is the shape `@polygonlabs/express`'s request
  validator actually emits (`{ error, message, info: ValidationErrorInfo }`
  with the section-keyed `z.treeifyError` tree).
- **401** with `ErrorResponseSchema` is added when the route declares
  `security` with at least one requirement.
- **500** with `ErrorResponseSchema` is added unconditionally.

`403` and `404` are **not** auto-injected. Both are handler-emitted (the
framework doesn't throw `Forbidden` or `NotFound` itself), so the registry
has no honest signal that a route can produce them. Declare those response
slots explicitly when a handler can throw them.

User-authored responses always win over inferred ones: a route that wants
a domain-shaped 400 — or that genuinely can't 500 — can still override by
declaring the slot itself. The merge is `{ ...inferred, ...route.responses }`,
so user keys replace inferred keys both at runtime and in the accumulated
`Ops` type that `OperationsOf<typeof buildRegistry>` exposes to consumers.

The codegen client picks the merged shapes up automatically — there's
nothing new to wire on the client side. Services using
`@polygonlabs/express`'s `createRegistryRouter` get the right OpenAPI
spec for free, and their hey-api–generated clients now have the correct
error types for every route the framework can fail.
