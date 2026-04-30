# @polygonlabs/express

## 1.1.0

### Minor Changes

- 1aa5a96: Add `/registry` subpath: registry-driven Express router.

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

### Patch Changes

- Updated dependencies [978435a]
  - @polygonlabs/openapi-registry@1.0.1

## 1.0.1

### Patch Changes

- c607110: Rename `requestContext` to `setupLogger` and republish so `dist/notFound.*`
  makes it into the npm tarball.

  The `requestContext` export read like a no-op middleware factory and hid the
  `getLogger()` fallback-priming side effect — the test/script gotcha
  documented in the README came from readers missing that the same call both
  mounts the per-request middleware and primes the out-of-request fallback.
  `setupLogger(logger)` surfaces that intent. The function's behaviour is
  unchanged; only the name and the `getLogger()` error-message text changed.

  Shipping as a patch despite being a breaking import: 1.0.0's published
  tarball was missing `dist/notFound.*`, so the documented import graph
  (`import { notFoundHandler } from '@polygonlabs/express'`) blew up at module
  load for any consumer. Renaming alongside the republish avoids spending a
  major bump on a name nobody could have actually used.

## 1.0.0

### Major Changes

- 7cef276: Initial stable release (1.0.0) of `@polygonlabs/express` — shared Express
  middleware for team services. Four named exports replace ~40 lines of
  per-service boilerplate:

  ```ts
  import express from 'express';
  import { createLogger } from '@polygonlabs/logger';
  import {
    requestContext,
    getLogger,
    notFoundHandler,
    createErrorHandler
  } from '@polygonlabs/express';

  const logger = await createLogger();
  const app = express();

  app.use(express.json());
  app.use(requestContext(logger));
  // ... routes ...
  app.use(notFoundHandler);
  app.use(createErrorHandler());
  ```

  ### What the package provides
  - `requestContext(rootLogger)` — Express middleware that wraps every
    request in an `AsyncLocalStorage` scope carrying a per-request child
    logger tagged with a `requestId`. No `declare module` type mutation
    on `Request`.
  - `getLogger()` — accessor that returns the current request's child
    logger from anywhere inside the request's async tree: route handlers,
    service functions, promise continuations, async work that outlives
    `res.end()`. Outside a request scope it returns the root logger
    passed to `requestContext`, so shared service-layer code runs
    correctly under both HTTP and cron contexts without branching.
    Throws with an actionable error if `requestContext` has never been
    mounted in the process — see the README gotcha for how to prime the
    fallback in tests and scripts.
  - `createErrorHandler()` — maps `HTTPError` subclass status codes onto
    the response and logs 5xx at debug via `getLogger()`. Derives the
    HTTP response body's `message` from the error after running it
    through `sanitiseEthersFetchError` from `@polygonlabs/logger`, so RPC
    tokens embedded in `?token=<secret>` query strings never reach the
    client — whatever message the service author intended (via `VError`,
    `WError`, an `HTTPError` subclass, or an unwrapped throw) bubbles up
    URL-free.
  - `notFoundHandler` — terminal middleware that throws `NotFound` so
    unmatched routes are formatted the same way as any other
    `HTTPError`.

  Log-side URL sanitisation is the logger package's responsibility — see
  `@polygonlabs/logger`'s 2.1.0 release for details. Every service that
  logs an ethers error anywhere (request handler, cron, background
  worker, unhandled rejection) gets the same protection once it updates
  to that version.

  See `README.md` and `MIGRATION.md` for usage and adoption guidance.

### Patch Changes

- Updated dependencies [50f175e]
- Updated dependencies [61094bd]
  - @polygonlabs/logger@2.1.0
  - @polygonlabs/verror@1.0.3
