# @polygonlabs/express

Shared Express middleware for Polygon Apps Team services. Four lines wires up
request-scoped structured logging, a global error handler that understands
`@polygonlabs/verror`'s `HTTPError` hierarchy, uniform 404 responses, and — the
reason this package exists — automatic sanitisation of ethers fetch errors so
RPC tokens embedded in query strings never leak into response bodies or logs.

## Why this package exists

Every Express service built from `apps-team-ts-template` needs the same three
pieces of boilerplate. Copy-pasting them into each service means any future
fix — a new RPC library with a similar leak fingerprint, a tighter log
policy — has to be hand-applied across every repo. Centralising here means a
single `pnpm update @polygonlabs/express` propagates fixes everywhere.

## Usage

```ts
import express from 'express';
import { createLogger } from '@polygonlabs/logger';
import {
  setupLogger,
  getLogger,
  notFoundHandler,
  createErrorHandler
} from '@polygonlabs/express';

const logger = await createLogger();
const app = express();

app.use(express.json());
app.use(setupLogger(logger));

app.get('/users/:id', async (req, res) => {
  getLogger().info({ userId: req.params.id }, 'fetching user');
  // ... service calls here can also reach getLogger() ...
  res.json(await fetchUser(req.params.id));
});

app.use(notFoundHandler);
app.use(createErrorHandler());
```

Order matters:

- `setupLogger(logger)` **before any route**, so every request is wrapped
  in an `AsyncLocalStorage` scope holding a child logger tagged with a fresh
  `requestId`. The same call also primes the out-of-request fallback
  returned by `getLogger()`.
- `notFoundHandler` **after all routes**, so only unmatched paths reach it.
- `createErrorHandler()` **last**, so `HTTPError` subclasses thrown from
  routes — and the `NotFound` thrown by `notFoundHandler` — are formatted
  uniformly.

### Calling `getLogger()` anywhere

Unlike `req.log`-style augmentation patterns, `getLogger()` is not tied to
the `Request` object. Anywhere inside the request's async tree — route
handlers, service functions, promise continuations, timers, async work that
outlives `res.end()` — call `getLogger()` and you get the same child logger
with the same `requestId`:

```ts
// src/services/fetchUser.ts — no `req` in sight
import { getLogger } from '@polygonlabs/express';

export async function fetchUser(id: string) {
  getLogger().debug({ userId: id }, 'fetchUser: querying');
  // ...
}
```

That also means log entries emitted from `setTimeout` callbacks, deferred
promise resolutions, or anything else that runs after the response is sent
still share the originating request's `requestId` — the ALS scope outlives
the handler.

### Out-of-request behaviour

Calls to `getLogger()` outside a request scope (server startup, cron jobs,
one-off scripts) return the root logger originally passed to
`setupLogger`. That means shared service-layer functions can be called
from both HTTP requests and cron workers without branching on context —
the callsite always gets a usable logger.

### Gotcha: prime the fallback before any out-of-request `getLogger()` call

`setupLogger(logger)` captures the root logger for the out-of-scope
fallback as a side effect — but only when the function is actually called.
If your startup code calls `getLogger()` *before* `setupLogger(logger)`
runs, the store is empty, the fallback has not been primed, and `getLogger()`
throws:

```text
getLogger() called before setupLogger() was ever called.
Mount `app.use(setupLogger(rootLogger))` during server setup, or call
`setupLogger(rootLogger)` once at startup to prime the fallback.
```

The throw is deliberate: silently substituting a no-op logger would mask a
real configuration bug. Two remedies:

- **Normal services:** call `app.use(setupLogger(logger))` as early as
  possible in your server setup — before any code that might call
  `getLogger()` runs.
- **Tests and scripts that never mount Express:** invoke
  `setupLogger(logger)` once at the top of the test file (or a test
  setup hook) to prime the fallback. You don't need to do anything with the
  returned middleware — the side effect of the call is what you want.

## Exports

| Export | Purpose |
|---|---|
| `setupLogger(logger)` | Captures `logger` as the out-of-request fallback for `getLogger()` and returns Express middleware that runs each request inside an `AsyncLocalStorage` scope holding a child logger bound with `requestId`. |
| `getLogger()` | Returns the current request's child logger, or the fallback root logger when called outside a request scope. Throws if `setupLogger` has never been invoked in this process. |
| `notFoundHandler` | Terminal middleware that throws `NotFound(method + path)`. |
| `createErrorHandler()` | Error-handler middleware: maps `HTTPError.statusCode`, logs 5xx at debug via `getLogger()`, and derives the HTTP response body's `message` from a URL-sanitised view of the error. |
| `@polygonlabs/express/registry` | Subpath: registry-driven Express router. `createRegistryRouter({ registry }).implement(handlers).toExpress()` builds a router whose routes derive entirely from a `TypedRegistry` (from `@polygonlabs/openapi-registry`), with request and response Zod validation that round-trips codecs end-to-end. See the subpath section below. |

No `declare module 'express-serve-static-core'` augmentation, no global
type mutation on `Request`. Call sites explicitly import `getLogger` from
this package.

## Ethers fetch-error sanitisation

`JsonRpcProvider`, `FallbackProvider`, and anything built on either ethers
v5's `Logger.throwError` or ethers v6's `FetchRequest` embed the full
request URL — including any `?token=<secret>` query string — in several
places on the thrown error. The structural detection and URL-stripping
that keeps those tokens out of log output lives in
[`@polygonlabs/logger`](../logger)'s pino `err` serializer, so every
`{ err }` log call everywhere in a service is protected automatically —
not only those routed through this package's error handler. See the
logger's README for shape details and the `sanitiseEthersFetchError`
export that drives it.

### How `createErrorHandler` uses it for the response body

When the error middleware runs, it calls `sanitiseEthersFetchError` on
the raw error and uses the sanitised clone's `.message` for the response
body. Whatever the service author intended to bubble up — the `VError`'s
compound message, a `WError`'s own text, an `HTTPError` subclass's
literal — arrives at the client with every URL in it reduced to its
origin. The handler does not second-guess the service author's choice of
wrapper; it only ensures the chosen message is URL-free.

## Registry-driven router (`/registry` subpath)

`@polygonlabs/express/registry` lifts the wiring between an
OpenAPI/Zod registry and an Express app into a single declarative
step. With a `TypedRegistry` from `@polygonlabs/openapi-registry`
holding the spec, the consumer writes a typed handler map and gets:

- request validation (params, query, body, headers) decoded into the
  codec runtime types,
- response validation that re-encodes the runtime types back to the
  wire shape via `z.encode` before send,
- compile-time exhaustiveness — `.implement()` accumulates handlers
  across calls and `.toExpress()` rejects the call (with the missing
  operationIds in the diagnostic) until every registered operation is
  bound,
- registry-driven auth: declare schemes once on the registry, tag
  protected operations with `security: [...]`, and `.auth(handlers)`
  requires a handler for every registered scheme — handler return
  types flow into per-operation `req.auth[schemeName]` typing.

```ts
import { createRegistryRouter, defineHandlers } from '@polygonlabs/express/registry';

import { buildRegistry, type Operations } from '@your/schemas';

const registry = buildRegistry();

const router = createRegistryRouter({ registry }).implement({
  getHello: (_req, res) => {
    res.json({ message: 'hello' });
  }
  // missing operations are a TS error at .toExpress() below.
});

const app = express();
app.use(router.toExpress());
```

### Composing handlers across modules

Real apps don't pile every handler into one literal at the wiring site.
`.implement()` accepts partial bags and accumulates across calls — handler
modules export their own bag (typed via `defineHandlers`) and the wiring
file composes them:

```ts
// routes/status.ts
import type { Operations } from '@your/schemas';
import { defineHandlers } from '@polygonlabs/express/registry';

export const statusHandlers = defineHandlers<Operations>()({
  getStatus: (_req, res) => res.json({ status: 'ok' }),
  getHealth: (_req, res) => res.json({ healthy: true })
});

// routes/management.ts
import type { Operations } from '@your/schemas';
import { defineHandlers } from '@polygonlabs/express/registry';
import type { AppAuthMap } from '../auth.ts';

export const managementHandlers = defineHandlers<Operations, AppAuthMap>()({
  rebalance: (req, res) => {
    // req.auth.apiKey is fully typed — flows from AppAuthMap.
    res.json({ ok: true, tenantId: req.auth.apiKey.tenantId });
  }
});

// index.ts — the wiring file
import { statusHandlers } from './routes/status.ts';
import { managementHandlers } from './routes/management.ts';

const router = createRegistryRouter({ registry })
  .auth(authHandlers)
  .implement(statusHandlers)
  .implement(managementHandlers);
//        ^^^^^^^^^^^^^^^^^^^^
// Type error here if any registered operation is unbound; the message
// names the missing operationIds. Add a final `.implement({...})` for any
// remaining ops (or import another module bag).

app.use(router.toExpress());
```

Each `.implement(bag)` rejects keys that aren't registered operationIds —
typos fail at the implement site, not the wiring site. The final
`.toExpress()` is where exhaustiveness is enforced; until every operation
has been bound across the chain of `.implement()` calls, the call won't
typecheck.

### Type-safe auth via `.auth(handlers)`

Services with mixed public and protected operations declare security
schemes on the registry and tag protected routes via OpenAPI's `security`
field. The router's `.auth(handlers)` method requires a handler for every
registered scheme — missing keys, surplus keys, and wrong-shape handlers
are TS errors at the call site.

```ts
// 1. Schemas package: register the scheme + tag the protected operation.
import { TypedRegistry } from '@polygonlabs/openapi-registry';
import { NotAuthenticated } from '@polygonlabs/verror';

const registry: TypedRegistry = new TypedRegistry();
registry.registerSecurityScheme('apiKey', {
  type: 'apiKey',
  name: 'x-api-key',
  in: 'header'
});

registry.registerPath({
  operationId: 'rebalance',
  method: 'post',
  path: '/management/rebalance',
  security: [{ apiKey: [] }],
  responses: {
    /* … */
  }
});

// 2. Service: provide one handler per registered scheme.
const router = createRegistryRouter({ registry })
  .auth({
    apiKey: async (req) => {
      const key = req.get('x-api-key');
      const tenant = await validateApiKey(key);
      if (!tenant) throw new NotAuthenticated('invalid api key');
      return tenant; // Awaited<typeof tenant> flows into req.auth.apiKey
    }
  })
  .implement({
    rebalance: (req, res) => {
      // req.auth.apiKey is fully typed — IDE autocomplete, no `as` casts.
      const tenantId = req.auth.apiKey.id;
      // …
    }
    // operations without `security` see no `req.auth` field at all.
  });

app.use(router.toExpress());
```

Auth runs before request validation — an unauthenticated request returns
401 without ever parsing the body. Auth handlers `throw NotAuthenticated`
/ `Forbidden` from `@polygonlabs/verror`; `createErrorHandler` answers
401 / 403. Plain `Error` thrown from an auth handler is wrapped to
`NotAuthenticated` so credential failures don't surface as 500s.

Multi-scheme AND is supported (`security: [{ apiKey: [], bearer: [] }]`
— both must succeed, both principals land on `req.auth`). OR semantics
(`security: [{ apiKey: [] }, { bearer: [] }]`) is rejected at
`toExpress()` setup time.

### Canonical error response schemas

The registry-driven router (in concert with `createErrorHandler`) emits
two error response shapes. The package exports the Zod schemas so every
service references the same definition rather than copy-pasting
`{ error: z.string() }` lookalikes that drift over time:

```ts
import {
  ErrorResponseSchema,
  ValidationErrorResponseSchema
} from '@polygonlabs/express/registry';

registry.registerPath({
  // …
  responses: {
    200: { /* … */ },
    400: {
      description: 'Request validation failed',
      content: { 'application/json': { schema: ValidationErrorResponseSchema } }
    },
    401: {
      description: 'Missing or invalid credentials',
      content: { 'application/json': { schema: ErrorResponseSchema } }
    }
  }
});
```

- **`ErrorResponseSchema`** — generic shape for any `HTTPError` (and the
  500 path). `{ error: true, message: string, info?: Record<string, unknown> }`.
- **`ValidationErrorResponseSchema`** — narrowed shape for the 400
  emitted by `createRequestValidator`. `info` is non-optional and
  section-keyed: `{ params?: tree, query?: tree, body?: tree, headers?: tree }`,
  where each tree is the recursive `z.treeifyError` output.
- **`ZodErrorTreeSchema`** / **`ValidationErrorInfoSchema`** — the
  building blocks, exported in case a domain-specific error wraps a
  partial tree.

Each schema is registered with `.openapi('Name', …)` so the
asteasolutions OpenAPI generator emits it as a `$ref` under
`components.schemas` rather than inlining the definition at every use
site. Add the schemas to your responses manually — the package
deliberately does not auto-augment routes; you stay in control of which
operations document which error codes.

Peer dependencies: `@polygonlabs/openapi-registry`,
`@asteasolutions/zod-to-openapi`, `zod` — declared as optional, only
required when the subpath is imported.
