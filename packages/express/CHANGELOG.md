# @polygonlabs/express

## 4.1.0

### Minor Changes

- [#69](https://github.com/0xPolygon/apps-team-packages/pull/69) [`799659e`](https://github.com/0xPolygon/apps-team-packages/commit/799659e92051bfbb6a7e1fca1bb2027ae20281bb) Thanks [@shan8851](https://github.com/shan8851)! - Registry router now runs request validation before auth handlers

  The registry-driven router previously ran an operation's auth handlers before
  validating the request, so auth handlers saw the raw parsed input and had to
  re-validate anything they read from it. Validation now runs first: a malformed
  request to any operation — including auth-protected ones — gets an immediate
  `400 Bad Request` with the canonical validation-error body, and auth handlers
  only ever run for well-formed requests, receiving the validated, codec-decoded
  `req.params` / `req.query` / `req.body`.

  ## Behaviour changes
  - A request that fails schema validation on an operation declaring `security`
    now returns `400` even when credentials are missing or invalid. Previously
    auth ran first and such requests returned `401` / `403`.
  - Auth handlers now observe the validated, decoded request sections rather
    than the raw parsed input. Handlers that defensively re-parsed the body
    through their own schema keep working, but that re-parse is now redundant
    and can be deleted.
  - Validation errors (field names and constraints from the request schema) are
    now visible to unauthenticated callers on protected routes. The schemas are
    already published in the OpenAPI document, so nothing secret is exposed.

## 4.0.0

### Minor Changes

- 037bfde: Closes an RPC-token leak class: `serializeError` and `VError.toJSON` now
  auto-sanitise RPC fetch errors before producing their JSON shape, so any
  URL embedded in `message`, `stack`, or `info.requestUrl` is reduced to
  its origin and `?token=<secret>` query strings never reach the serialised
  output. Every persistence path — log lines (already covered via the pino
  `err` serializer, unchanged), Firestore documents that store error
  snapshots, status routes that ship the JSON directly to clients, Sentry
  events — is safe by default. No call-site change required.

  The same sanitiser also now covers **viem** alongside ethers v5/v6.
  viem's `RpcRequestError` and `HttpRequestError` (fingerprinted on the
  class name plus `metaMessages` being an array, a viem `BaseError`-specific
  marker) trigger the chain rebuild. Every wrapping viem error
  (`ContractFunctionExecutionError`, `EstimateGasExecutionError`, …)
  inherits URL stripping via the per-node walk.

  ## Why this is in `@polygonlabs/verror` now

  The sanitiser is an Error primitive — peer with `cause`, `info`,
  `fullStack` — not a logging concern. It lived in `@polygonlabs/logger`
  historically because logger was the first consumer, but that meant every
  other persistence path had to remember to wire it in by hand. The
  [l2-spol-rebalancer-mainnet](https://github.com/0xPolygon/lst-api/tree/main/packages/l2-spol-rebalancer)
  `/service-status` leak (2026-05-19) happened because the state machine's
  `setError` action called `serializeError(err)` on a viem-wrapped
  `VError`, reasonably assuming `serializeError` was safe; it wasn't.
  Moving the sanitiser down the dep graph and invoking it inside
  `serializeError` removes the footgun for every future caller.

  ## `serializeError` is now the canonical entry point

  `sanitiseRpcFetchError` is exported (and re-exported by
  `@polygonlabs/logger` for back-compat) but marked `@internal` — services
  should prefer `serializeError` / `VError.toJSON` for any serialisation
  work. The lower-level primitive is appropriate only for pipelines that
  need `Error`-in/`Error`-out semantics (the canonical case is logger's
  pino `err` serializer, which feeds the sanitised clone into pino's
  `stdSerializers.err`).

  `@polygonlabs/express`'s `createErrorHandler` has been migrated to
  `serializeError` accordingly — it now reads `message` off the serialised
  shape rather than calling the sanitiser directly. The exported behaviour
  is unchanged.

  ## Backward compatibility
  - `sanitiseRpcFetchError` is still re-exported from `@polygonlabs/logger`
    so any existing
    `import { sanitiseRpcFetchError } from '@polygonlabs/logger'` site
    keeps working without code change. (The previous name —
    `sanitiseEthersFetchError` — was renamed in this release since the
    function now covers viem; the rename hits any direct caller at
    typecheck time rather than silently.)
  - Public type signatures unchanged.
  - Behaviour change for `serializeError`: a chain containing an RPC
    fetch error now produces sanitised JSON instead of the verbatim
    message text. Any code that was relying on the URL being present in
    serialised output was a leak — this is the fix, not a break.

  ## Additional fix: `serializeError` preserves more fields on plain Errors

  `serializeError`'s plain-Error branch now preserves `info` and
  `shortMessage` from the input when present, instead of always emitting
  `info: {}` and `shortMessage: message`. Sanitised clones (which are
  plain Errors with `info` / `shortMessage` attached during the chain
  rebuild) carry both fields through to the serialised output, and any
  plain Error that happens to have those attached benefits incidentally.

### Patch Changes

- Updated dependencies [037bfde]
  - @polygonlabs/verror@1.1.0
  - @polygonlabs/logger@3.0.0

## 3.0.0

### Major Changes

- d88e55c: The registry router's framework middleware now responds directly at the
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

### Patch Changes

- Updated dependencies [53a9c3c]
- Updated dependencies [a7338c5]
  - @polygonlabs/openapi-registry@2.1.0
  - @polygonlabs/verror@1.0.4
  - @polygonlabs/logger@2.1.0

## 2.0.0

### Major Changes

- 6fdf77e: Remove `defineHandlers<Ops, AuthMap>()` in favour of `HandlerMapFor<F, AuthMap>` + `satisfies`.

  ## Breaking changes

  `defineHandlers<Operations, AuthMap>()` is removed. The two-call form was a workaround for TypeScript's lack of partial type-argument application; modern TS has `satisfies` which obviates it. Per-domain handler bags now look like:

  ```ts
  // before
  import type { Operations } from '@my/schemas';
  import type { AppAuthMap } from '../auth.ts';
  import { defineHandlers } from '@polygonlabs/express/registry';

  export const managementHandlers = defineHandlers<Operations, AppAuthMap>()({
    rebalance: (req, res) => {
      /* … */
    }
  });

  // after
  import type { HandlerMapFor } from '@polygonlabs/express/registry';
  import type { buildRegistry } from '@my/schemas';
  import type { AppAuthMap } from '../auth.ts';

  export const managementHandlers = {
    rebalance: (req, res) => {
      /* … */
    }
  } satisfies Partial<HandlerMapFor<typeof buildRegistry, AppAuthMap>>;
  ```

  Consumers no longer import a separate `Operations` type alias from the schemas package — `HandlerMapFor<typeof buildRegistry, AuthMap>` derives the manifest from the builder function's inferred return type.

  ## New helpers
  - `HandlerMapFor<F, AuthMap>` — handler-map type for a registry-builder function. Use with `satisfies Partial<HandlerMapFor<…>>` for typed per-domain bags.
  - `AuthHandlerMapFor<F>` — auth-handler-map type for a registry-builder function. Use with `satisfies` when defining auth handlers.
  - `OperationsOf` and `SchemesOf` are re-exported from `@polygonlabs/openapi-registry` for convenience.

  ## Peer dependency bump

  Requires `@polygonlabs/openapi-registry` major version corresponding to the chainable-API release (registry-side type changes are visible via the structural reads in `RegistryOps<R>` / `RegistrySchemes<R>`).

  ## Build hygiene

  The build now cleans `dist/` + `*.tsbuildinfo` before `tsc` and verifies each `exports` entry point loads at the end. Catches the "incremental tsc skipped a file" failure mode that broke the initial 1.0.x npm publish (compiled `dist/` was missing `notFound.js`).

### Patch Changes

- Updated dependencies [1b5d48f]
  - @polygonlabs/openapi-registry@2.0.0
  - @polygonlabs/verror@1.0.3

## 1.1.1

### Patch Changes

- cc31c39: `@polygonlabs/express/registry`'s error response schemas
  (`ErrorResponseSchema`, `ValidationErrorResponseSchema`,
  `ValidationErrorInfoSchema`, `ZodErrorTreeSchema`) now re-export from
  `@polygonlabs/openapi-registry/error-schemas` rather than defining them
  locally. The exported instances are unchanged — same schema objects,
  same `.openapi('Name', …)` registration — so existing import paths keep
  working without code changes.

  The peer-dep range for `@polygonlabs/openapi-registry` is tightened to
  `^1.1.0` (from `^1.0.1`) since the re-export needs the new
  `./error-schemas` subpath. Consumers of `@polygonlabs/express/registry`
  that were already on openapi-registry 1.0.1 should bump to 1.1.x to
  avoid the peer-dep warning.

  Schemas-only packages that want the canonical error response shapes
  without dragging in Express + pino + Sentry should now import directly
  from `@polygonlabs/openapi-registry/error-schemas`.

- Updated dependencies [cc31c39]
  - @polygonlabs/openapi-registry@1.1.0

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
