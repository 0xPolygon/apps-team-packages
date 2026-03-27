---
"@polygonlabs/logger": major
---

VError and WError handling is now automatic for every log level — no special method required.

## Breaking change

`logError()` has been removed. Replace call sites with standard pino log methods:

```ts
// before
logger.logError({ err })
logger.logError({ err, requestId }, 'optional message')

// after
logger.error({ err }, err.message)
logger.error({ err, requestId }, 'optional message')
```

## What you get automatically

- **WError unwrapping** — when `err` is a `WError`, the logger transparently logs the cause instead. The wrapper's message is never the useful signal.
- **`error_info`** — merged `VError.info()` from the full cause chain is emitted under `error_info` for every log level (`warn`, `error`, etc.), not just calls through the old `logError`.
- **Sentry capture** — `sentry.captureException()` fires automatically for `logger.error({ err })` calls. It does not fire for `warn` or other levels.

## Reserved key

`error_info` is written by the logger and must not be included in merge objects. If a caller supplies it, the logger emits a `warn`-level entry with the conflicting value under `callerErrorInfo`, then overwrites the key with the real VError info.

## `AppLogger` type removed

`createLogger` now returns pino's `Logger` directly. If your service declared `AppLogger` as a constructor parameter type, change it to `Logger` from `pino`.
