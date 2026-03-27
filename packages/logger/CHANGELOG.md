# @polygonlabs/logger

## 1.0.0

Stable public release. No breaking API changes since 0.3.0.

### Patch Changes

- d4ee9dd: `sentry.captureException()` now fires at `fatal` log level in addition to `error`
- 407be6f, f5092b7: Build scripts now run `typecheck` before `tsc -p`
- Updated dependencies
  - @polygonlabs/verror@1.0.0

## 0.3.0

### Major Changes

- ce34487: VError and WError handling is now automatic for every log level — no special method required.

  ## Breaking change

  `logError()` has been removed. Replace call sites with standard pino log methods:

  ```ts
  // before
  logger.logError({ err });
  logger.logError({ err, requestId }, 'optional message');

  // after
  logger.error({ err }, err.message);
  logger.error({ err, requestId }, 'optional message');
  ```

  ## What you get automatically
  - **WError unwrapping** — when `err` is a `WError`, the logger transparently logs the cause instead. The wrapper's message is never the useful signal.
  - **`error_info`** — merged `VError.info()` from the full cause chain is emitted under `error_info` for every log level (`warn`, `error`, etc.), not just calls through the old `logError`.
  - **Sentry capture** — `sentry.captureException()` fires automatically for `logger.error({ err })` calls. It does not fire for `warn` or other levels.

  ## Reserved key

  `error_info` is written by the logger and must not be included in merge objects. If a caller supplies it, the logger emits a `warn`-level entry with the conflicting value under `callerErrorInfo`, then overwrites the key with the real VError info.

  ## `AppLogger` type removed

  `createLogger` now returns pino's `Logger` directly. If your service declared `AppLogger` as a constructor parameter type, change it to `Logger` from `pino`.

## 0.2.0

### Patch Changes

- d903a42: Package exports now use `src/` when consumed inside the workspace and `dist/` when installed from npm. `publishConfig` rewrites the `exports` map to point at compiled output for npm consumers.

## 0.1.0

### Major Changes

- 783168e: Introduces `@polygonlabs/logger` — a shared pino-based logger for Polygon Apps Team services.

  ## What it provides
  - **`AppLogger`** — a `pino.Logger` with one additional method: `logError`
  - **`createLogger(options?)`** — async factory that returns a configured `AppLogger`
    instance ready for dependency injection
  - **`SentryAdapter`** — interface for optional Sentry capture integration

  ## `logError({ err, ...context }, message?)`

  The only method `AppLogger` adds to the standard pino API. Mirrors pino's merge-object
  signature with `err` as a required key. VError/WError-aware:
  - **Plain `Error`** — logged with the error serialised under `err` and the error message
    as the log message
  - **`VError`** — same, plus `info` from the full cause chain emitted under the reserved
    `error_info` key, cleanly separated from call-site context
  - **`WError`** — the wrapper is discarded; only the cause is logged. A WError's message
    describes the high-level context but the cause is the actual error

  `err` must be an `Error` instance — non-Error values are rejected at the type level.

  `error_info` is also a **TypeScript-reserved key**: passing it in the context object is a
  compile-time error, eliminating any risk of collision between error-carried and
  call-site context.

  ```ts
  const err = new VError('query failed', { info: { requestId: 'abc' } });
  logger.logError({ err, traceId: 'xyz' });
  // { message: 'query failed', err: {...}, traceId: 'xyz', error_info: { requestId: 'abc' } }

  logger.logError({ err, traceId: 'xyz' }, 'user-facing message');
  // message override for the log entry
  ```

  ## Configuration

  Pre-configured for Datadog ingestion:
  - `message` key (renamed from pino's default `msg`)
  - ISO 8601 `timestamp` field (renamed from pino's default `time`)
  - String level labels (`"info"`) instead of numeric values (`30`)
  - `pid` and `hostname` suppressed

  All customisation — service-level fields, log level, serializers, redaction — is done
  via `child()`, which returns `AppLogger` at every depth so `logError` is always available.

  ## Usage

  ```ts
  import { createLogger } from '@polygonlabs/logger';

  const base = await createLogger({ sentry: Sentry });
  const logger = base.child(
    { service: 'user-api', env: process.env.NODE_ENV },
    { level: process.env.LOG_LEVEL ?? 'info' }
  );

  try {
    await db.query(sql);
  } catch (err) {
    logger.logError({ err, requestId });
  }
  ```

### Patch Changes

- 783168e: Integrates `@polygonlabs/verror` as the error wrapper, replacing the external `verror` dependency.
- 61797d5: Adds `repository` field to `package.json` for npm trusted publishing.
