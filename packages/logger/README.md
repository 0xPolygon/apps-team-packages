# @polygonlabs/logger

Shared pino-based logger for Polygon Apps Team services. Pre-configured for Datadog
ingestion with automatic VError-aware error handling and optional Sentry capture.

## Why this package exists

Every service in the team needs the same pino configuration: `message` key instead of
`msg`, ISO 8601 timestamps, string level labels, no `pid`/`hostname`. Getting this right
in each service individually leads to drift — one service logs `"msg"` while another logs
`"message"`, breaking Datadog log parsing.

This package provides one factory and a consistent output shape across all services.
VError/WError handling and Sentry capture are wired in at the pino level, so every log
call benefits automatically — no special method required.

## Usage

```ts
import { createLogger } from '@polygonlabs/logger';

const logger = await createLogger();
logger.info({ requestId: '123' }, 'request received');
logger.error({ err }, err.message);
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
  constructor(private readonly logger: Logger) {}

  async getUser(id: string) {
    const log = this.logger.child({ userId: id });
    // ...
  }
}
```

`createLogger` returns pino's `Logger` type directly — import it from `pino`.

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
async function handleRequest(req: Request, logger: Logger) {
  const log = logger.child({ requestId: req.id, method: req.method });
  log.info('handling request');
  log.error({ err }, err.message);
}
```

Child bindings and options merge at any depth — grandchild loggers carry all ancestor
bindings, and all VError/WError behaviour is preserved at every level.

## VError and WError handling

VError/WError handling is automatic for every log level. Pass `err` in the merge object
as you would any other pino log call:

```ts
logger.error({ err }, err.message)
logger.warn({ err, requestId }, 'degraded — retrying')
logger.error({ err, requestId, userId }, 'optional message override')
```

### `error_info`

VError `info` fields from the full cause chain are always emitted under the reserved
`error_info` key — never spread at the top level. This keeps error-carried context clearly
separated from call-site context, with no collision risk:

```ts
const err = new VError('query failed', { info: { requestId: 'abc', table: 'users' } });
logger.error({ err, traceId: 'xyz' }, err.message);
// {
//   level: 'error', message: 'query failed', err: { ... },
//   traceId: 'xyz',                                  ← call-site context, top level
//   error_info: { requestId: 'abc', table: 'users' } ← error info, always nested
// }
```

If a VError has no `info`, the `error_info` key is omitted entirely.

`error_info` is a **reserved key** — do not include it in merge objects. If a caller
supplies it, the logger emits a `warn`-level diagnostic with the conflicting value under
`callerErrorInfo`, then overwrites the key with the real VError info.

### Behaviour by `err` type

**Plain `Error`** — logged with the error under `err` (serialised via pino's built-in
`stdSerializers.err`) and the error message as the log message. No `error_info` key:

```ts
logger.error({ err: new Error('connection refused') }, 'connection refused');
// { level: 'error', message: 'connection refused', err: { message, stack, type } }
```

**`VError`** — same as plain `Error`, plus VError `info` nested under `"error_info"`:

```ts
const err = new VError('query failed', { info: { requestId: 'abc', table: 'users' } });
logger.error({ err }, err.message);
// { level: 'error', message: 'query failed', err: { ... }, error_info: { requestId: 'abc', table: 'users' } }
```

**`WError`** — the wrapper is discarded entirely; only the cause is logged. Call-site
context is carried through to the cause's entry:

```ts
const root = new Error('connection refused');
const err = new WError('could not load user', { cause: root });
logger.error({ err, requestId: 'abc' }, err.message);
// { level: 'error', message: 'connection refused', err: { ... }, requestId: 'abc' }
// 'could not load user' is NOT logged — the cause is what matters
```

The cause is processed by the same rules, so a `WError` wrapping a `VError` with `info`
will emit the `VError`'s `error_info` alongside call-site context.

## Ethers fetch-error sanitisation

Ethers v5 and v6 fetch errors (thrown by `JsonRpcProvider`,
`FallbackProvider`, `StaticJsonRpcProvider`, and anything else built on
ethers' web fetch layer) embed the full request URL — including any
`?token=<secret>` query string — in `err.message`, `err.stack`, and (v6)
`err.info.requestUrl` or (v5) top-level `err.url`. Without intervention,
any `logger.debug({ err })` / `logger.error({ err })` call that receives
one of these errors propagates the token into log output via pino's
default err serialiser.

This package's pino `err` serializer detects ethers fetch errors
structurally (duck-typed on the v5/v6 fingerprints — no runtime
dependency on ethers) and replaces them with a sanitised clone before
emission. Every `{ err }` log call is protected automatically: HTTP
request handlers, cron ticks, background workers,
`unhandledRejection` catches, startup failures, anywhere.

The full `.cause` chain is preserved: a service that wraps an RPC
failure with `new VError('fetching block number', { cause: rpcErr })`
still sees both the "what was being attempted" wrapper and the
sanitised RPC node. URL-stripping runs across every node's `message`
and `stack` as defence in depth; the ethers node's `info` is rebuilt to
`{ requestUrl: origin, responseStatus? }` (drops v5's leaky top-level
`body`/`responseText`/`url`, drops v6's other info fields alongside
`requestUrl`); wrappers' own `info` is preserved unchanged.

The detector is also exported as `sanitiseEthersFetchError(err): Error | null`
for service-level unit tests, and for `@polygonlabs/express`'s global
error handler to reuse when deriving HTTP response-body messages. The
sanitiser is unaware of log-vs-response surfaces: it returns a
sanitised Error clone, and callers route it wherever they need.

## Sentry

If a Sentry client was passed to `createLogger`, `captureException` fires automatically
for every `logger.error({ err })` call. It does not fire for `warn`, `info`, or other
levels — only `error`.

For a `WError`, the cause is captured rather than the wrapper, consistent with what is
logged.

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

### Reserved keys

Two keys in the merge object are reserved and will trigger a `warn`-level diagnostic if
supplied by a caller:

| Key | Written by | Conflicting value preserved as |
|-----|-----------|-------------------------------|
| `timestamp` | `timestamp` function | `callerTimestamp` |
| `error_info` | VError info extractor | `callerErrorInfo` |
