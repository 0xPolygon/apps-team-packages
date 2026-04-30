# @polygonlabs/express

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
