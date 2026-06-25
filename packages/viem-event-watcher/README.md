# @polygonlabs/viem-event-watcher

Backpressure-aware async-generator wrappers over viem's `getLogs`.

They turn a contract's log history and tip into an **ordered, pull-driven
stream** of decoded log batches. They yield batches and **throw** on failure —
nothing is logged, no observer object is injected, and there is no
`EventEmitter`. The consuming application owns the cursor, dedup/reorg handling,
restart policy, and logging.

The generators are generic over the ABI event tuple, so the yielded `logs`
carry typed `args` and an `eventName` discriminant — narrow on `eventName` in
the consumer rather than re-deriving event names from topic selectors.

`viem` is a peer dependency.

## Why

We built this because **viem's `watchEvent` delivers logs inconsistently against
the RPCs we run on** — Polygon **bor** in particular — and it has bitten us on
multiple occasions.

The cause is *how* viem watches. With `poll: true` (the default for HTTP
transports, and the same for `watchContractEvent`), if the RPC advertises
`eth_newFilter` support viem opens a **server-side filter** and polls it with
`eth_getFilterChanges`; it only falls back to `eth_getLogs` when the RPC doesn't
support filters at all. bor advertises filter support but its filters are
unreliable — they silently stop returning new tip logs (or the node
drops/expires the filter, or a load-balanced poll lands on a node that never saw
it). Because bor "supports" `eth_newFilter`, viem never falls back to `getLogs`,
and because the failure is **silent** — no error, no end-of-stream, `onLogs`
just goes quiet — an indexer keeps running while missing every new event. (With
a WebSocket transport, `poll: false` uses `eth_subscribe`, which has the same
silent-gap failure mode under connection churn.)

A plain `eth_getLogs` query over an explicit block range has no server-side
state to rot: each call is a fresh, deterministic request the node either
answers or rejects outright. This package is built entirely on `getLogs` —
including a self-driven poll loop for the live tail instead of `watchEvent` — so
log delivery is consistent across RPCs, and any failure surfaces as a thrown
error rather than silence.

## API

```ts
import { createPublicClient, http, parseAbiItem } from 'viem';
import { streamEvents } from '@polygonlabs/viem-event-watcher';

const client = createPublicClient({ transport: http(rpcUrl) });
const events = [parseAbiItem('event ExchangeRateUpdated(uint256 rate)')] as const;
const controller = new AbortController();

for await (const { phase, logs, toBlock } of streamEvents({
  client,
  address,
  events,
  fromBlock,
  batchSize: 10_000n,
  pollingInterval: 1_000,
  signal: controller.signal
})) {
  // `phase` is 'backfill' while catching up, then 'live'.
  for (const log of logs) {
    // `log.eventName` and `log.args` are typed from `events`.
    await handle(log); // awaited → the next batch can't be fetched until this returns
  }
  // Advance your persisted cursor to the scanned high-water-mark. `toBlock`
  // moves forward even across ranges that produced no matching logs.
  await saveCursor(toBlock);
}
```

Each generator yields an `EventBatch` — `{ logs, toBlock }` — per scanned block
range. `streamEvents` yields `StreamItem`, which adds a `phase` field.

- **`backfillEvents`** — finite historical `getLogs` scan from `fromBlock` to
  `toBlock`, chunked by `batchSize`.
- **`watchEvents`** — live tail via a self-driven `getLogs` poll loop, not
  viem's filter-based `watchEvent` (see [Why](#why)). Each poll is bounded to
  `batchSize` blocks, so a cursor far behind the tip (a service resumed after
  downtime, or the chain racing ahead of a slow consumer) chunks through the
  backlog rather than requesting a range the RPC rejects. `batchSize` is
  required.
- **`streamEvents`** — backfill `fromBlock`→tip, then tail live from `tip + 1`
  with no gap, tagging each batch with its `phase`.

## Design notes

- **Backpressure is the `yield`.** The next `getLogs` can't fire until the
  consumer pulls the previous batch, so a consumer slower than `pollingInterval`
  simply spaces polls out — it never builds an unbounded buffer. **Every scanned
  range yields a batch, even an empty one**, so the gate holds across
  event-sparse regions too, not only at event-bearing blocks.
- **`toBlock` is a monotonic high-water-mark.** Advance your persisted cursor to
  `batch.toBlock` after each batch. Because empty ranges are yielded, the cursor
  moves forward across quiet stretches instead of stalling at the last
  event-bearing block.
- **No backfill/dedup cursor inside the watcher.** Pass the `fromBlock` you want
  (e.g. `lastProcessed - reorgDepth`); dedup downstream. The watcher only
  guarantees gapless block coverage across the backfill→live boundary.
- **Cancellation via `AbortSignal`** — abort to stop a stream and restart with a
  fresh `fromBlock`. `signal` is honoured *between* viem calls; an in-flight
  `getLogs` / `getBlockNumber` is not itself cancelled, so abort takes effect
  once the current call settles.
- **Fail-fast validation.** `streamEvents` validates `events` (non-empty) and
  `batchSize` (positive) before any RPC round-trip, so a misconfiguration throws
  immediately rather than after a network call.
- **No internal logging.** Errors surface by throwing from the generator; wrap
  the `for await` in your own retry/backoff loop and log once at that boundary.

## Migrating from `@polygonlabs/servercore`'s `EventConsumer`

See [MIGRATION.md](./MIGRATION.md).
