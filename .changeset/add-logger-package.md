---
"@polygonlabs/logger": major
---

Introduces `@polygonlabs/logger` — a shared pino-based logger for Polygon Apps Team services.

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
