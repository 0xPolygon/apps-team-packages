# @polygonlabs/verror

## 1.1.2

### Patch Changes

- [#73](https://github.com/0xPolygon/apps-team-packages/pull/73) [`006cf08`](https://github.com/0xPolygon/apps-team-packages/commit/006cf081e794bb156cee0f37fabc450c5b03e7c5) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Ship the LICENSE file inside the published npm package

  The previous release added the Apache-2.0 license at the repo root and
  declared it in package.json, but npm only auto-includes a LICENSE file
  in the packed tarball when it lives in the same directory as the
  package's own package.json. The license metadata was correct but the
  actual license text was missing from the published package — this adds
  it.

## 1.1.1

### Patch Changes

- [#71](https://github.com/0xPolygon/apps-team-packages/pull/71) [`aa81b1a`](https://github.com/0xPolygon/apps-team-packages/commit/aa81b1a73e0b4711d195c12e12120f5f67191305) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Add Apache-2.0 license: the package now declares `"license": "Apache-2.0"` in its `package.json`, and the repository carries the full Apache License 2.0 text. Previously no license was declared.

## 1.1.0

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

## 1.0.4

### Patch Changes

- a7338c5: Bugfix: HTTPError is now W-by-default. The cause's message is no longer
  appended to an HTTPError's own `.message` — matching what the team
  standard has always documented ("Use WError at REST API boundaries").
  HTTP errors exist for the API boundary; leaking a downstream cause's
  text into `.message` was the bug. Three coordinated changes inside
  `@polygonlabs/verror`, all behind the same `WERROR_SYMBOL` marker that
  already identifies `WError`:
  - `HTTPError.prototype[WERROR_SYMBOL] = true` (set in a static block on
    the class). `VError`'s constructor reads it via
    `new.target.prototype` during `super()`, so every subclass
    (`BadRequest`, `NotAuthenticated`, `NotFound`, `GeneralError`, …)
    inherits the W behaviour without per-class wiring.
  - `VErrorOptions.skipCauseMessage` removed (it was marked `@internal`
    and only set by `WError`'s constructor). The decision now lives on
    the prototype where it belongs — no hidden runtime flag, no
    two-sources-of-truth for "is this a boundary wrapper?"
  - `WError.toString()` override deleted. It was explicitly re-appending
    the cause's message via `; caused by ${cause.toString()}`, defeating
    the boundary semantic that `.message` was respecting. `String(wErr)`,
    template literals, log-formatter fallbacks — anywhere a WError gets
    stringified — now surface only the boundary author's own message.
    The cause stays reachable via `err.cause` / `VError.cause(err)`.

  Adopting this is a patch: every public API stays the same, and
  `.message` on HTTPErrors that were thrown without a cause is unchanged.
  The only behaviour difference is HTTPErrors thrown with `{ cause }` —
  previously the cause's text leaked into `.message` (the bug); now it
  does not. Code relying on the leaked text was relying on a contract
  the team standard explicitly told it not to use.

## 1.0.3

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

## 1.0.2

### Patch Changes

- ea88e1e: Fix `instanceof MultiError` failing across module boundaries in `errorForEach`

  `@polygonlabs/verror` now exports `MULTIERROR_SYMBOL` (`Symbol.for('@polygonlabs/verror/is-multierror')`). MultiError and all subclasses carry this symbol as an instance property. `VError.errorForEach` uses `MULTIERROR_SYMBOL` to identify MultiError instances instead of `instanceof MultiError`, fixing silent incorrect behaviour when multiple copies of the package are loaded.

- e99ba29: Fix `instanceof WError` failing across module boundaries when multiple copies of `@polygonlabs/verror` are loaded

  `@polygonlabs/verror` now exports `WERROR_SYMBOL` (`Symbol.for('@polygonlabs/verror/is-werror')`). WError and all subclasses carry this symbol as an instance property. Because `Symbol.for()` uses the V8 global registry, the same symbol value is returned in every module copy — unlike `instanceof`, which compares prototype chains and silently returns `false` when two copies of the class exist.

  `@polygonlabs/logger` now uses `WERROR_SYMBOL` to identify WError instances in the log hook, fixing a silent failure where WError cause chains were not unwrapped when the host service and the logger each had their own copy of `@polygonlabs/verror` in `node_modules`. `@polygonlabs/verror` is also moved from `dependencies` to `peerDependencies`, ensuring a single shared copy in consuming services.

  ## Migration

  Add `@polygonlabs/verror` to your service's direct `dependencies` if it is not already present — pnpm will warn if the peer is missing.

## 1.0.1

### Patch Changes

- 820c80a: `MIGRATION.md` is now included in the published npm bundle.

  Previously, `MIGRATION.md` was present in the repository but absent from the `files`
  allowlist in `package.json`, so it was silently dropped when packages were published
  to the registry. Consumers who installed a package and looked for migration guidance
  would find no file. Adding `"MIGRATION.md"` to `files` ensures it ships alongside
  `dist/` in every release.

## 1.0.0

Stable public release. No API changes since 0.2.0.

## 0.2.0

### Patch Changes

- d903a42: Package exports now use `src/` when consumed inside the workspace and `dist/` when installed from npm. `publishConfig` rewrites the `exports` map to point at compiled output for npm consumers.
- 051cb1c: `MultiError.toJSON()` now correctly serializes each error in the `errors` array.

  Previously, spreading plain `Error` objects into the array produced `{}` entries when
  the result was passed to `JSON.stringify`, because the `Error` class has no enumerable
  own properties. The `errors` array is now mapped through `serializeError`, giving each
  entry the same `{ name, message, shortMessage, cause, info }` shape as any other
  serialized error in the cause chain.

## 0.1.0

### Major Changes

- 783168e: Introduces `@polygonlabs/verror` — a TypeScript-first rewrite of `@openagenda/verror` with
  full browser and Node.js support.

  ## What it provides
  - **`VError`** — the base error class. The cause's message is appended to the wrapping
    message (`"wrapper: root cause"`), and `info` fields accumulate through the cause chain
    via `VError.info()`.
  - **`WError`** — a "wrapped error" that keeps the cause message separate from the error's
    own message, preventing ever-growing message strings in deep cause chains.
  - **`MultiError`** — a container for multiple concurrent errors.
  - **`HTTPError`** base class and 17 concrete subclasses (`BadRequest`, `NotFound`,
    `Forbidden`, etc.) with a typed `statusCode` property and `toJSON()` that includes it.
  - **`serializeError(err)`** — serialises any `Error` (including plain errors and native
    ES2022 `Error.cause` chains) to the same JSON shape as `VError.toJSON()`, so the full
    cause chain is preserved when errors cross RPC boundaries or land in structural logs.
  - **Static helpers** also exported as standalone named functions:
    `cause`, `info`, `fullStack`, `findCauseByName`, `findCauseByType`,
    `hasCauseWithName`, `hasCauseWithType`, `errorFromList`, `errorForEach`

  ## Why

  The original `verror` npm package ships only CommonJS and relies on Node-specific patterns
  that break in modern ESM environments and bundlers. `@openagenda/verror` added browser
  support but remains JavaScript-only with no TypeScript types and no active maintenance.
  This package re-implements the same semantics in TypeScript with a clean ESM build, proper
  type declarations, and team-standard tooling.

  Zero runtime dependencies. Plain string messages only (no printf-style formatting).

  ## Usage

  ```ts
  import { VError, WError, NotFound, serializeError } from '@polygonlabs/verror';

  const root = new Error('database unavailable');
  const err = new VError('query failed', { cause: root, info: { requestId: 'abc' } });

  throw new NotFound('resource not found', { cause: err });
  ```
