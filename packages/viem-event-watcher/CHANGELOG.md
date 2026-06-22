# @polygonlabs/viem-event-watcher

## 1.0.0

Initial release — backpressure-aware async-generator wrappers over viem's `getLogs`. They yield one `EventBatch` (`{ logs, toBlock }`) per scanned range — including empty ranges, so backpressure holds across event-sparse regions and a persisted cursor can advance to `toBlock` monotonically — and throw on failure. No observer injection, no `EventEmitter`, no internal logging. The consuming application owns the cursor, dedup/reorg handling, restart policy, and logging.

- **`backfillEvents`** — finite historical scan, chunked by `batchSize`.
- **`watchEvents`** — live tail via a self-driven `getLogs` poll loop. `yield` is the backpressure: the next poll can't fire until the consumer pulls the previous batch, so a slow consumer just spaces polls out instead of building an unbounded buffer. Each call is bounded to `batchSize` blocks, so a cursor far behind the tip (service resumed after downtime, or the chain racing ahead of a slow consumer) chunks through the backlog rather than issuing a block range RPCs reject. Plain `eth_getLogs` rather than filter-based `watchEvent`, which is unreliable on some RPCs (notably Polygon bor).
- **`streamEvents`** — gapless backfill→live from `fromBlock`, tagging each batch with its `phase`.
- Generic over the ABI event tuple, so yielded logs carry typed `args` and an `eventName` discriminant. `viem` is a peer dependency; cancellation via `AbortSignal`.
