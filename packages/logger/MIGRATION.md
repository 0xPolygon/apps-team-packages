# Migration Guide

## 1.x → 2.0.0

### Update `@polygonlabs/verror` from a transitive to a direct dependency

`@polygonlabs/verror` has moved from `dependencies` to `peerDependencies`. It must
now be listed as a direct `dependency` in your service's `package.json`:

```json
"dependencies": {
  "@polygonlabs/verror": ">=1.0.2"
}
```

pnpm will warn at install time if the peer is missing.

### Replace `error_info` with `err.info` in log reads and Datadog queries

The top-level `error_info` field is removed. VError info is now written under
`err.info` by the pino error serialiser, which walks the full cause chain and
merges info from every link. Previously, `error_info` only captured the
top-level error's info — context attached to wrapped causes was silently dropped.

**Datadog** — update any saved searches, log queries, monitors, or dashboard
widgets that reference `@error_info.*`:

```text
# before
@error_info.requestId:*

# after
@err.info.requestId:*
```

**Code that reads structured logs** (e.g. integration tests or log parsers) —
replace `log.error_info` with `log.err.info`.

---

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
