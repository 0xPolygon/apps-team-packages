# Migration Guide

## 0.2 → 0.3

### Replace `logError()` with standard pino log methods

`logError()` has been removed. VError and WError handling is now automatic for
every standard pino log level, so the dedicated method is no longer needed.

```ts
// before
logger.logError({ err });
logger.logError({ err, requestId }, 'optional message');

// after
logger.error({ err }, err.message);
logger.error({ err, requestId }, 'optional message');
```

WError unwrapping, `error_info` emission, and Sentry capture all happen
automatically on `logger.error({ err })` calls — no special method required.

> **Note:** `error_info` is a reserved key written by the logger. Do not include
> it in merge objects passed to any log method. If a caller supplies it, the logger
> emits a `warn`-level entry with the conflicting value under `callerErrorInfo`
> and overwrites the key with the real VError info.

### Replace `AppLogger` with pino's `Logger` type

`createLogger` now returns pino's `Logger` directly. If your service declared
`AppLogger` as a parameter or field type, update it to `Logger` from `pino`.

```ts
// before
import { createLogger, AppLogger } from '@polygonlabs/logger';

class MyService {
  constructor(private logger: AppLogger) {}
}

// after
import { createLogger } from '@polygonlabs/logger';
import type { Logger } from 'pino';

class MyService {
  constructor(private logger: Logger) {}
}
```
