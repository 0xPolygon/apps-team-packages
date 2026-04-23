# Migration Guide

## Adopting `@polygonlabs/express` (replacing per-service copies)

Services currently carry their own `src/errors.ts` (the ethers fetch-error
sanitiser + global error handler), a per-request `req.log` middleware, and
a `declare module 'express-serve-static-core'` augmentation. Replace those
with this package.

### Step 1 — Install

```bash
pnpm add @polygonlabs/express
```

### Step 2 — Replace the inline middleware

```ts
// Before
app.use((req, _res, next) => {
  req.log = logger.child({ requestId: randomUUID() });
  next();
});
// ... 404 handler ...
// ... local errors.ts createErrorHandler() wiring ...

// After
import {
  requestContext,
  notFoundHandler,
  createErrorHandler
} from '@polygonlabs/express';

app.use(requestContext(logger));
// routes
app.use(notFoundHandler);
app.use(createErrorHandler());
```

### Step 3 — Replace `req.log` call sites with `getLogger()`

This is the only non-mechanical step. Previously:

```ts
app.get('/users/:id', (req, res) => {
  req.log.info({ userId: req.params.id }, 'fetching user');
  // ...
});
```

Now:

```ts
import { getLogger } from '@polygonlabs/express';

app.get('/users/:id', (req, res) => {
  getLogger().info({ userId: req.params.id }, 'fetching user');
  // ...
});
```

Service-layer functions that previously had to accept a `logger` parameter
for correlation can drop it — `getLogger()` reaches through the
`AsyncLocalStorage` scope and returns the same child logger the route
handler sees.

### Step 4 — Delete the local copies

- `src/errors.ts` (sanitiser + global error handler) — replaced by
  `createErrorHandler()` from this package.
- The `req.log` middleware — replaced by `requestContext()`.
- The `declare module 'express-serve-static-core'` block — no longer
  required. This package does not mutate the `Request` type.
- `@types/express-serve-static-core` from `devDependencies`, unless you
  have another reason to depend on it directly.

### Step 5 — Prime `getLogger()` in tests or scripts that don't mount Express

`requestContext(logger)` captures the root logger for the out-of-scope
fallback as a side effect of being called. In production this happens
automatically during server setup. In test files or scripts that never
mount the full server but still import code that calls `getLogger()`, add
a one-off priming call:

```ts
// tests/helpers/agent.ts (or equivalent)
import { createLogger } from '@polygonlabs/logger';
import { requestContext } from '@polygonlabs/express';

const logger = await createLogger();
requestContext(logger); // primes the fallback; returned middleware unused
```

Without this, a `getLogger()` call from inside imported service code will
throw:

```text
getLogger() called before requestContext() was ever mounted. ...
```

The throw is deliberate — substituting a no-op would mask real
configuration bugs. See `README.md` for the full rationale.

### Behaviour changes to note

- **Response shapes, status codes, and log output are unchanged** — the
  sanitiser, error-handler, and child-logger logic moved verbatim.
- **`req.log` is no longer set.** Call `getLogger()` instead. TypeScript
  will flag every remaining `req.log` reference after you remove the
  local augmentation.
- **Logger context now outlives `res.end()`.** Deferred work (timers,
  promise continuations scheduled before the response was sent) still
  resolves to the originating request's child logger via ALS — a minor
  upgrade over the old pattern, where such entries lost the `requestId`
  binding.
- **Both ethers majors are sanitised.** Per-service sanitisers copied
  from `apps-team-ts-template` (before this package existed) only
  recognised v6-shaped errors. v5 services — where the RPC URL lives at
  top-level `err.url` rather than nested `err.info.requestUrl` — gain
  sanitisation coverage when switching to this package. If your local
  copy already handled both majors, this is a no-op. See README for
  details.
