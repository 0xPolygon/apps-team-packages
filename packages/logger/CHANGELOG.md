# @polygonlabs/logger

## 3.0.2

### Patch Changes

- [#73](https://github.com/0xPolygon/apps-team-packages/pull/73) [`006cf08`](https://github.com/0xPolygon/apps-team-packages/commit/006cf081e794bb156cee0f37fabc450c5b03e7c5) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Ship the LICENSE file inside the published npm package

  The previous release added the Apache-2.0 license at the repo root and
  declared it in package.json, but npm only auto-includes a LICENSE file
  in the packed tarball when it lives in the same directory as the
  package's own package.json. The license metadata was correct but the
  actual license text was missing from the published package — this adds
  it.

- Updated dependencies [[`006cf08`](https://github.com/0xPolygon/apps-team-packages/commit/006cf081e794bb156cee0f37fabc450c5b03e7c5)]:
  - @polygonlabs/verror@1.1.2

## 3.0.1

### Patch Changes

- [#71](https://github.com/0xPolygon/apps-team-packages/pull/71) [`aa81b1a`](https://github.com/0xPolygon/apps-team-packages/commit/aa81b1a73e0b4711d195c12e12120f5f67191305) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Add Apache-2.0 license: the package now declares `"license": "Apache-2.0"` in its `package.json`, and the repository carries the full Apache License 2.0 text. Previously no license was declared.

- Updated dependencies [[`aa81b1a`](https://github.com/0xPolygon/apps-team-packages/commit/aa81b1a73e0b4711d195c12e12120f5f67191305)]:
  - @polygonlabs/verror@1.1.1

## 3.0.0

### Minor Changes

- 037bfde: Closes an RPC-token leak class: `serializeError` and `VError.toJSON` now
  auto-sanitise RPC fetch errors before producing their JSON shape, so any
  URL embedded in `message`, `stack`, or `info.requestUrl` is reduced to
  its origin and `?token=<secret>` query strings never reach the serialised
  output. Every persistence path — log lines (already covered via the pino
  `err` serializer, unchanged), Firestore documents that store error
  snapshots, status routes that ship the JSON directly to clients, Sentry
  events — is safe by default. No call-site change required.

  The same sanitiser also now covers **viem** alongside ethers v5/v6.
  viem's `RpcRequestError` and `HttpRequestError` (fingerprinted on the
  class name plus `metaMessages` being an array, a viem `BaseError`-specific
  marker) trigger the chain rebuild. Every wrapping viem error
  (`ContractFunctionExecutionError`, `EstimateGasExecutionError`, …)
  inherits URL stripping via the per-node walk.

  ## Why this is in `@polygonlabs/verror` now

  The sanitiser is an Error primitive — peer with `cause`, `info`,
  `fullStack` — not a logging concern. It lived in `@polygonlabs/logger`
  historically because logger was the first consumer, but that meant every
  other persistence path had to remember to wire it in by hand. The
  [l2-spol-rebalancer-mainnet](https://github.com/0xPolygon/lst-api/tree/main/packages/l2-spol-rebalancer)
  `/service-status` leak (2026-05-19) happened because the state machine's
  `setError` action called `serializeError(err)` on a viem-wrapped
  `VError`, reasonably assuming `serializeError` was safe; it wasn't.
  Moving the sanitiser down the dep graph and invoking it inside
  `serializeError` removes the footgun for every future caller.

  ## `serializeError` is now the canonical entry point

  `sanitiseRpcFetchError` is exported (and re-exported by
  `@polygonlabs/logger` for back-compat) but marked `@internal` — services
  should prefer `serializeError` / `VError.toJSON` for any serialisation
  work. The lower-level primitive is appropriate only for pipelines that
  need `Error`-in/`Error`-out semantics (the canonical case is logger's
  pino `err` serializer, which feeds the sanitised clone into pino's
  `stdSerializers.err`).

  `@polygonlabs/express`'s `createErrorHandler` has been migrated to
  `serializeError` accordingly — it now reads `message` off the serialised
  shape rather than calling the sanitiser directly. The exported behaviour
  is unchanged.

  ## Backward compatibility
  - `sanitiseRpcFetchError` is still re-exported from `@polygonlabs/logger`
    so any existing
    `import { sanitiseRpcFetchError } from '@polygonlabs/logger'` site
    keeps working without code change. (The previous name —
    `sanitiseEthersFetchError` — was renamed in this release since the
    function now covers viem; the rename hits any direct caller at
    typecheck time rather than silently.)
  - Public type signatures unchanged.
  - Behaviour change for `serializeError`: a chain containing an RPC
    fetch error now produces sanitised JSON instead of the verbatim
    message text. Any code that was relying on the URL being present in
    serialised output was a leak — this is the fix, not a break.

  ## Additional fix: `serializeError` preserves more fields on plain Errors

  `serializeError`'s plain-Error branch now preserves `info` and
  `shortMessage` from the input when present, instead of always emitting
  `info: {}` and `shortMessage: message`. Sanitised clones (which are
  plain Errors with `info` / `shortMessage` attached during the chain
  rebuild) carry both fields through to the serialised output, and any
  plain Error that happens to have those attached benefits incidentally.

### Patch Changes

- Updated dependencies [037bfde]
  - @polygonlabs/verror@1.1.0

## 2.1.0

### Minor Changes

- 50f175e: The default pino `err` serializer now sanitises ethers v5 and v6 fetch
  errors before emission. `JsonRpcProvider`, `FallbackProvider`,
  `StaticJsonRpcProvider`, and anything else built on ethers' web fetch
  layer embed the full request URL — including any `?token=<secret>`
  query string — in `err.message`, `err.stack`, and (v6)
  `err.info.requestUrl` or (v5) top-level `err.url`. Any
  `logger.debug({ err })` / `logger.error({ err })` call that previously
  received such an error propagated the token into log output; the
  sanitiser now intercepts that in the serializer layer, so every
  service's log path is protected automatically — HTTP request handlers,
  cron ticks, background workers, `unhandledRejection` catches, startup
  failures, anywhere.

  Detection is structural (duck-typed on the v5/v6 fingerprints), so the
  logger does not depend on ethers. The full `.cause` chain is preserved:
  a service that wraps an ethers error with
  `new VError('fetching block number', { cause: rpcErr })` still sees both
  the "what was being attempted" wrapper and the sanitised RPC node in
  its logs. URL-stripping runs across every node's `message` and `stack`
  as defence in depth; the ethers node's `info` is rebuilt to
  `{ requestUrl: origin, responseStatus? }` (drops v5's leaky top-level
  `body`/`responseText`/`url`, drops v6's other info fields alongside
  `requestUrl`); wrappers' own `info` is preserved unchanged so operators
  keep any context the service attached.

  Exported as `sanitiseEthersFetchError(err): Error | null` for services
  that need to unit-test their own error paths, and for
  `@polygonlabs/express`'s global error handler to reuse the sanitised
  `.message` for HTTP response bodies (the sanitiser is unaware of which
  surface the output is destined for — callers route it).

### Patch Changes

- 61094bd: Standardise the `exports` shape in `package.json` on the team-standards
  `@polygonlabs/source` three-condition pattern: workspace consumers resolve
  `./src/index.ts` via the custom condition (build-free typecheck), published
  consumers continue to get `./dist/...` via `publishConfig.exports`.
  Previously `@polygonlabs/verror` used a `types: ./src, import: ./src`
  variant and `@polygonlabs/logger` pointed exclusively at `./dist` with no
  source condition at all — both now share a single uniform shape alongside
  any other TypeScript-consumed package in the workspace. No change for npm
  consumers.
- Updated dependencies [61094bd]
  - @polygonlabs/verror@1.0.3

## 2.0.0

### Major Changes

- d7ea53e: VError info is now emitted as `err.info` instead of the top-level `error_info` field

  The `err` serializer now calls `VError.info()` to walk the full cause chain and merge info from every link. Previously, `error_info` was written as a separate top-level field and only captured the top-level error's info — cause chain context was silently dropped. The `error_info` field is removed entirely.

  ## Migration

  Update any Datadog log queries, saved searches, monitors, or dashboards that reference `@error_info.*` to use `@err.info.*` instead.

### Patch Changes

- e99ba29: Fix `instanceof WError` failing across module boundaries when multiple copies of `@polygonlabs/verror` are loaded

  `@polygonlabs/verror` now exports `WERROR_SYMBOL` (`Symbol.for('@polygonlabs/verror/is-werror')`). WError and all subclasses carry this symbol as an instance property. Because `Symbol.for()` uses the V8 global registry, the same symbol value is returned in every module copy — unlike `instanceof`, which compares prototype chains and silently returns `false` when two copies of the class exist.

  `@polygonlabs/logger` now uses `WERROR_SYMBOL` to identify WError instances in the log hook, fixing a silent failure where WError cause chains were not unwrapped when the host service and the logger each had their own copy of `@polygonlabs/verror` in `node_modules`. `@polygonlabs/verror` is also moved from `dependencies` to `peerDependencies`, ensuring a single shared copy in consuming services.

  ## Migration

  Add `@polygonlabs/verror` to your service's direct `dependencies` if it is not already present — pnpm will warn if the peer is missing.

- Updated dependencies [ea88e1e]
- Updated dependencies [e99ba29]
  - @polygonlabs/verror@1.0.2

## 1.0.2

### Patch Changes

- f13dbf5: Caller-supplied reserved keys in log merge objects are now preserved in a nested `_logger` field rather than being dropped or flat-renamed.

  Previously, passing `timestamp` in a merge object renamed it to `callerTimestamp`, while `error_info` and `service` were silently dropped (with a warning). The flat rename created a second collision surface — `callerTimestamp` could itself collide — and the behaviour was inconsistent across keys.

  Now all reserved keys (`timestamp`, `message`, `error_info`, `service`, `host`) are collected into a single `_logger: { ... }` object. This approach has one collision surface (`_logger` itself) instead of one per key, and the value is never lost. A single warn is emitted listing all affected keys.

  If `_logger` is already present in the merge object as a plain object, the caller's values are merged into it rather than overwritten.

## 1.0.1

### Patch Changes

- 820c80a: `MIGRATION.md` is now included in the published npm bundle.

  Previously, `MIGRATION.md` was present in the repository but absent from the `files`
  allowlist in `package.json`, so it was silently dropped when packages were published
  to the registry. Consumers who installed a package and looked for migration guidance
  would find no file. Adding `"MIGRATION.md"` to `files` ensures it ships alongside
  `dist/` in every release.

- eb445a5: `Logger`, `Level`, and `DestinationStream` types are now exported directly from `@polygonlabs/logger`.

  Previously, consumers needed to `import type { Logger } from 'pino'` to type-annotate logger instances,
  requiring a direct pino dependency. All three types are now re-exported from the package so consumers
  can import them from `@polygonlabs/logger` without adding pino as an explicit dependency.

  `createLogger` now also handles a missing `pino-pretty` gracefully: if `pretty: true` is passed but
  `pino-pretty` is not installed, the logger falls back to JSON output and emits a warning rather than
  throwing an import error.

- Updated dependencies [820c80a]
  - @polygonlabs/verror@1.0.1

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
