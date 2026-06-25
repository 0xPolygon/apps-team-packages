# @polygonlabs/viem-event-watcher

## 1.0.1

### Patch Changes

- bfec695: Republish with the correct published `exports` map. The `1.0.0` artifact was published in a way that did not apply `publishConfig.exports`, so it shipped the development `exports` — including the `@polygonlabs/source` condition pointing at `./src/index.ts`, which is not part of the published tarball (`files` ships only `dist`). Consumers that resolve through the `@polygonlabs/source` condition (any monorepo configured with `resolve.conditions: ['@polygonlabs/source']`, e.g. a Vitest/Vite setup) therefore failed to resolve the package — `Failed to resolve entry for package "@polygonlabs/viem-event-watcher"` — even though plain Node resolution via the `import` condition worked.

  This release republishes via the standard pnpm/changesets pipeline, which applies `publishConfig.exports` so the published package exposes only `types` and `import` (→ `dist/`), matching every other `@polygonlabs/*` package. No source changes — the package code is unchanged from `1.0.0`.

## 1.0.0

Initial release — backpressure-aware async-generator wrappers over viem's `getLogs`. They yield one `EventBatch` (`{ logs, toBlock }`) per scanned range — including empty ranges, so backpressure holds across event-sparse regions and a persisted cursor can advance to `toBlock` monotonically — and throw on failure. No observer injection, no `EventEmitter`, no internal logging. The consuming application owns the cursor, dedup/reorg handling, restart policy, and logging.

- **`backfillEvents`** — finite historical scan, chunked by `batchSize`.
- **`watchEvents`** — live tail via a self-driven `getLogs` poll loop. `yield` is the backpressure: the next poll can't fire until the consumer pulls the previous batch, so a slow consumer just spaces polls out instead of building an unbounded buffer. Each call is bounded to `batchSize` blocks, so a cursor far behind the tip (service resumed after downtime, or the chain racing ahead of a slow consumer) chunks through the backlog rather than issuing a block range RPCs reject. Plain `eth_getLogs` rather than filter-based `watchEvent`, which is unreliable on some RPCs (notably Polygon bor).
- **`streamEvents`** — gapless backfill→live from `fromBlock`, tagging each batch with its `phase`.
- Generic over the ABI event tuple, so yielded logs carry typed `args` and an `eventName` discriminant. `viem` is a peer dependency; cancellation via `AbortSignal`.
