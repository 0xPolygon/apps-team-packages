---
'@polygonlabs/express': minor
---

Add `/registry` subpath: registry-driven Express router.

`createRegistryRouter({ registry }).auth(authHandlers).implement(handlers).toExpress()` materialises an Express router whose routes are derived entirely from operations registered on a `TypedRegistry` from `@polygonlabs/openapi-registry` (or any compatible `OpenAPIRegistry`). Each operation is bound by `operationId` and wrapped in request and response validators that round-trip codecs end-to-end — request bodies and path/query parameters are decoded into runtime types before the handler runs; response bodies are encoded back to the wire shape via `z.encode` before being sent.

Coverage is enforced at compile time. `.implement(handlers)` accepts a partial bag and accumulates handlers across calls — handler bags from per-domain modules can be composed at the wiring site. `.toExpress()`'s `this:` type guard then closes the gate: when any registered operation has no bound handler, the call fails to typecheck with the missing operationIds visible in the diagnostic. Surplus keys (typos at the implement site) are TS errors at the call site, not the wiring site. The new `defineHandlers<Operations, AuthMap>()` helper types module-style handler bags so each handler's `req` / `res` narrows to the operation's typed view without needing a `satisfies Pick<HandlerMap, ...>` ceremony.

Request validation collects every section's failures (params, query, body, headers) before throwing a single `BadRequest` from `@polygonlabs/verror`, with `info` keyed by section name and each value the `z.treeifyError` tree for that section. Clients get every problem to fix in one round trip — read e.g. `info.body.properties.label.errors[0]` directly rather than walking a flat issues list — instead of fix-one-resubmit-discover-the-next.

## Type-safe authentication via `.auth(handlers)`

For services with mixed public and protected operations, declare security schemes on the registry (`registry.registerSecurityScheme('apiKey', { type: 'apiKey', name: 'x-api-key', in: 'header' })`) and tag protected operations with `security: [{ apiKey: [] }]` in their `RouteConfig`. The router's `.auth(handlers)` method requires a handler for every registered scheme — missing keys, surplus keys, and wrong-shape handlers are TS errors at the call site, the same exhaustiveness `.implement()` already enforces for operation handlers.

Auth handlers run **before** request validation, so an unauthenticated request returns 401 without ever parsing the body. Each handler's return type flows into per-operation `req.auth[schemeName]` typing — `req.auth.apiKey` is the apiKey handler's awaited return value, with full IDE autocomplete and type-checking. Operations without `security` see no `req.auth` field at all (it's omitted from the typed `Request`, not just empty). Handlers throw `NotAuthenticated` / `Forbidden` from `@polygonlabs/verror` and `createErrorHandler` answers 401/403 with the existing info-surfacing path; plain `Error` thrown from an auth handler is wrapped to `NotAuthenticated` so credential-validation failures don't surface as 500s.

Multi-scheme AND semantics are supported (`security: [{ apiKey: [], bearer: [] }]` — both must succeed, both principals land on `req.auth`). OR semantics (`security: [{ apiKey: [] }, { bearer: [] }]`) is rejected at `toExpress()` setup time with a clear message.

The subpath also exports `openApiToExpressPath` / `expressToOpenApiPath` for OpenAPI ↔ Express path conversion, plus the typed handler shapes `Handler<Op, AuthMap>`, `HandlerMap<Ops, AuthMap>`, `TypedRequest<Op, AuthMap>`, `TypedResponse<Op>`, and the auth shapes `AuthHandler<Principal>`, `AuthHandlerMap<SchemeNames>`.

The `request.headers` array form (`ZodType[]` — asteasolutions's "registered parameter" reuse pattern) is rejected at validator setup time with a clear pointer at the object form (`z.object({ 'x-foo': z.string() })`); the object form is strictly more flexible for runtime validation and produces the same OpenAPI output.

## Canonical error response schemas

The subpath also exports the Zod schemas for the error response shapes that the router (in concert with `createErrorHandler`) actually emits — so the OpenAPI spec accurately documents what clients will see, with no per-service copy-pasted definitions to drift:

- **`ErrorResponseSchema`** — generic `{ error: true, message: string, info?: Record<string, unknown> }` for any `HTTPError` and the 500 path.
- **`ValidationErrorResponseSchema`** — narrowed shape for the 400 emitted by `createRequestValidator`. `info` is section-keyed (`params?`, `query?`, `body?`, `headers?`) with each value the recursive `z.treeifyError` tree.
- **`ZodErrorTreeSchema`** / **`ValidationErrorInfoSchema`** — the building blocks, exported for consumers wrapping partial trees in domain-specific errors.

Each schema is registered with `.openapi('Name')` so the asteasolutions OpenAPI generator emits it as a `$ref` under `components.schemas`. Consumers reference them from their `responses[code].content` slots manually; the package does not auto-augment routes.

## Behaviour change to `createErrorHandler`

`createErrorHandler` now surfaces `err.info` to the response body when the error is an `HTTPError` and `info` is non-empty. The response shape becomes `{ error: true, message, info }` instead of `{ error: true, message }`. Plain `Error` instances (mapped to status 500) and `HTTPError` instances with no info continue to produce the original two-field response — opt-in by class choice. This is the channel the registry-driven router uses to surface its `BadRequest` validation trees, but it is generic to any `HTTPError` that carries structured info.

`@polygonlabs/openapi-registry` (>= 1.0.0), `@asteasolutions/zod-to-openapi` (>= 8.0.0), and `zod` (>= 4.0.0) are added as optional peer dependencies — only required when the new subpath is imported.
