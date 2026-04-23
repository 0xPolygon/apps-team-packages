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
  requestContext,
  getLogger,
  notFoundHandler,
  createErrorHandler
} from '@polygonlabs/express';

const logger = await createLogger();
const app = express();

app.use(express.json());
app.use(requestContext(logger));

app.get('/users/:id', async (req, res) => {
  getLogger().info({ userId: req.params.id }, 'fetching user');
  // ... service calls here can also reach getLogger() ...
  res.json(await fetchUser(req.params.id));
});

app.use(notFoundHandler);
app.use(createErrorHandler());
```

Order matters:

- `requestContext(logger)` **before any route**, so every request is wrapped
  in an `AsyncLocalStorage` scope holding a child logger tagged with a fresh
  `requestId`.
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
`requestContext`. That means shared service-layer functions can be called
from both HTTP requests and cron workers without branching on context —
the callsite always gets a usable logger.

### Gotcha: prime the fallback before any out-of-request `getLogger()` call

`requestContext(logger)` captures the root logger for the out-of-scope
fallback as a side effect — but only when the factory is actually invoked.
If your startup code calls `getLogger()` *before* `app.use(requestContext(logger))`
runs, the store is empty, the fallback has not been primed, and `getLogger()`
throws:

```text
getLogger() called before requestContext() was ever mounted.
Mount `app.use(requestContext(rootLogger))` during server setup, or pass
the root logger to a one-off `requestContext(rootLogger)` call at startup
to prime the fallback.
```

The throw is deliberate: silently substituting a no-op logger would mask a
real configuration bug. Two remedies:

- **Normal services:** call `app.use(requestContext(logger))` as early as
  possible in your server setup — before any code that might call
  `getLogger()` runs.
- **Tests and scripts that never mount Express:** invoke
  `requestContext(logger)` once at the top of the test file (or a test
  setup hook) to prime the fallback. You don't need to do anything with the
  returned middleware — the side effect of the call is what you want.

## Exports

| Export | Purpose |
|---|---|
| `requestContext(logger)` | Middleware that runs each request inside an `AsyncLocalStorage` scope holding a child logger bound with `requestId`. Also captures `logger` as the out-of-scope fallback. |
| `getLogger()` | Returns the current request's child logger, or the fallback root logger when called outside a request scope. Throws if `requestContext` has never been invoked in this process. |
| `notFoundHandler` | Terminal middleware that throws `NotFound(method + path)`. |
| `createErrorHandler()` | Error-handler middleware: maps `HTTPError.statusCode`, logs 5xx at debug via `getLogger()`, and derives the HTTP response body's `message` from a URL-sanitised view of the error. |

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
