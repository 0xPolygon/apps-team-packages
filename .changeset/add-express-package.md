---
'@polygonlabs/express': major
---

Initial stable release (1.0.0) of `@polygonlabs/express` — shared Express
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
