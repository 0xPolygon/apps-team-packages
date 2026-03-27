# @polygonlabs/logger

Shared pino-based logger for Polygon Apps Team services. Pre-configured for Datadog
ingestion with VError-aware error logging and optional Sentry capture.

## Why this package exists

Every service in the team needs the same pino configuration: `message` key instead of
`msg`, ISO 8601 timestamps, string level labels, no `pid`/`hostname`. Getting this right
in each service individually leads to drift — one service logs `"msg"` while another logs
`"message"`, breaking Datadog log parsing.

This package provides one factory, one type, and a consistent output shape across all
services.

## Usage

```ts
import { createLogger } from '@polygonlabs/logger';

const logger = await createLogger();
logger.info({ requestId: '123' }, 'request received');
logger.logError({ err });
```

**Do not import as a module-level singleton.** Construct once at the service entry point
and pass down via constructor arguments or function parameters. Module-level singletons
make it impossible to add scoped bindings per request, swap the logger in tests, or
integrate Sentry cleanly.

```ts
// entry point
const logger = await createLogger({ sentry });

// handler / service layer
class UserService {
  constructor(private readonly logger: AppLogger) {}

  async getUser(id: string) {
    const log = this.logger.child({ userId: id });
    // ...
  }
}
```

## Customisation via child loggers

`createLogger()` intentionally does not accept options for the output shape — that
consistency is the point of the package. All customisation happens through `child()`.

`child(bindings, options?)` takes two arguments. The first attaches context fields; the
second (pino's `ChildLoggerOptions`) changes behaviour for that subtree:

| Option | Effect |
|--------|--------|
| `level` | Minimum log level for this child and all its descendants |
| `serializers` | Add or override field serializers (e.g. custom `req` formatting) |
| `redact` | Strip sensitive field paths before they reach the transport |

**Service-level setup** — create one child immediately after construction with the fields
and options that should apply everywhere in the service:

```ts
const base = await createLogger({ sentry });
const logger = base.child(
  { service: 'user-api', version: process.env.npm_package_version, env: process.env.NODE_ENV },
  { level: process.env.LOG_LEVEL ?? 'info' }
);
// Inject `logger` (not `base`) into the rest of the app.
```

**Serializers and redaction** — scope them to a subtree so they only apply where needed:

```ts
const httpLogger = logger.child(
  { component: 'http' },
  {
    serializers: { req: (req) => ({ method: req.method, url: req.url }) },
    redact: ['req.headers.authorization', 'req.headers.cookie']
  }
);
```

**Request/handler-scoped fields** — create further children inside handlers:

```ts
async function handleRequest(req: Request, logger: AppLogger) {
  const log = logger.child({ requestId: req.id, method: req.method });
  log.info('handling request');   // { service, env, requestId, method, message }
  log.logError({ err });          // { service, env, requestId, method, err, message }
}
```

Child bindings and options merge at any depth — grandchild loggers carry all ancestor
bindings, and `logError` and `child()` are preserved at every level.

## `AppLogger` type

`AppLogger` is a standard `pino.Logger` with two additions:

- **`logError({ err, ...context }, message?)`** — VError/WError-aware error logging (see below)
- **`child()`** — overridden to return `AppLogger` so child loggers carry `logError`
  at any depth

Use `AppLogger` as the type throughout your service code rather than importing
`createLogger` everywhere.

## `logError({ err, ...context }, message?)`

`logError` is the only method `AppLogger` adds to the standard pino API. Its signature
mirrors pino's merge-object form with `err` as a required key:

```ts
try {
  await db.query(sql);
} catch (err) {
  logger.logError({ err });
  logger.logError({ err, requestId, userId });                  // with call-site context
  logger.logError({ err, requestId }, 'user-facing message');   // with message override
}
```

Any fields beyond `err` are merged into the log entry at the top level, exactly as they
would be if you called `logger.error({ err, requestId }, message)` directly. All entries
carry the child bindings of the logger and are always at `error` level.

`err` must be an `Error` instance — passing a non-Error is a TypeScript error. For unknown
values from a catch block, narrow first or fall back to `logger.error()` directly:

```ts
try {
  await something();
} catch (err) {
  if (err instanceof Error) {
    logger.logError({ err });
  } else {
    logger.error(String(err));
  }
}
```

### VError `info` is namespaced under `"error_info"`

VError `info` fields from the full cause chain are always emitted under the reserved
`error_info` key — never spread at the top level. This keeps error-carried context clearly
separated from call-site context, with no collision risk and no precedence rules to remember:

```ts
const err = new VError('query failed', { info: { requestId: 'abc', table: 'users' } });
logger.logError({ err, traceId: 'xyz' });
// { level: 'error', message: 'query failed', err: { ... },
//   traceId: 'xyz',                               ← call-site context, top level
//   error_info: { requestId: 'abc', table: 'users' } ← error info, always nested
// }
```

`error_info` is a **reserved key** in the context object — passing it is a TypeScript error:

```ts
logger.logError({ err, error_info: { foo: 'bar' } });
//                     ^^^^^^^^^^ TypeScript error: error_info is not assignable to never
```

If a VError has no `info`, the `error_info` key is omitted from the log entry entirely.

### Behaviour by `err` type

**Plain `Error`** — logged with the error under `err` (serialised via pino's built-in
`stdSerializers.err`) and the error message as the log message. No `error_info` key:

```ts
logger.logError({ err: new Error('connection refused') });
// { level: 'error', message: 'connection refused', err: { message, stack, type } }
```

**`VError`** — same as plain `Error`, plus VError `info` nested under `"error_info"`:

```ts
const err = new VError('query failed', { info: { requestId: 'abc', table: 'users' } });
logger.logError({ err });
// { level: 'error', message: 'query failed', err: { ... }, error_info: { requestId: 'abc', table: 'users' } }
```

**`WError`** — the wrapper is discarded entirely; only the cause is logged. Call-site
context is carried through to the cause's entry:

```ts
const root = new Error('connection refused');
const err = new WError('could not load user', { cause: root });
logger.logError({ err, requestId: 'abc' });
// { level: 'error', message: 'connection refused', err: { ... }, requestId: 'abc' }
// 'could not load user' is NOT logged — the cause is what matters
```

The cause is processed by the same rules, so a `WError` wrapping a `VError` with `info`
will emit the `VError` entry with `info` nested and call-site context at the top level.

### Sentry

If a Sentry client was passed to `createLogger`, `logError` captures alongside the pino
entries: `captureException` for `Error` instances, `captureMessage` for non-Error values.
For a `WError`, only the cause is captured — consistent with the logging behaviour above.

```ts
import * as Sentry from '@sentry/node';

const base = await createLogger({ sentry: Sentry });
```

The `sentry` option accepts any object satisfying `{ captureException, captureMessage }`.
`@sentry/node` is not imported directly, so it stays an optional peer dependency. Sentry
is propagated automatically to all child loggers.

## Development output

Pass `{ pretty: true }` for human-readable output. Requires `pino-pretty` to be installed
as a peer dependency:

```ts
const logger = await createLogger({ pretty: process.env.NODE_ENV !== 'production' });
```

## Output format

The logger is pre-configured for Datadog ingestion:

| Field | Value |
|-------|-------|
| `message` | log message (pino's default `msg` is renamed) |
| `level` | string label: `"info"`, `"error"`, etc. |
| `timestamp` | ISO 8601: `"2024-01-01T12:00:00.000Z"` |
| `pid`, `hostname` | suppressed |
| `err` | serialised via pino's built-in `stdSerializers.err` |

Passing a `timestamp` key in a merge object is detected and renamed to `callerTimestamp`
with a warning. Letting caller-supplied timestamps shadow the authoritative timestamp
causes Datadog to sort log entries incorrectly.
