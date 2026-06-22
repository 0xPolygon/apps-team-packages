import type { AbiEvent, Address, GetLogsReturnType, PublicClient } from 'viem';

/**
 * `@polygonlabs/viem-event-watcher`
 *
 * Backpressure-aware async-generator wrappers over viem's `getLogs`. They yield
 * one {@link EventBatch} per scanned block range — the decoded `logs` plus the
 * `toBlock` high-water-mark — and throw on failure. No observer injection, no
 * `EventEmitter`, no internal logging. The consuming application owns the
 * cursor, dedup/reorg handling, restart policy, and logging.
 *
 * Every scanned range yields a batch **even when it contains no matching logs**.
 * That is deliberate: it is the suspension point that enforces backpressure on
 * every chunk (including across event-sparse regions), and it lets the consumer
 * advance a persisted cursor to `toBlock` monotonically rather than only at
 * event-bearing blocks.
 *
 * - {@link backfillEvents} — finite historical scan, chunked by `batchSize`.
 * - {@link watchEvents} — live tail: a self-driven `getLogs` poll loop. `yield`
 *   gates the next poll, so a consumer slower than `pollingInterval` simply
 *   spaces polls out (no unbounded buffering); each call is bounded to
 *   `batchSize` blocks, so a cursor far behind the tip chunks through the
 *   backlog instead of requesting a range RPCs reject. Plain `eth_getLogs`
 *   rather than filter-based `watchEvent`, which is unreliable on some RPCs
 *   (notably Polygon bor).
 * - {@link streamEvents} — backfill from `fromBlock` to the current tip, then
 *   tail live with no gap, tagging each batch with its `phase`.
 *
 * `signal` is honoured *between* viem calls — an in-flight `getLogs` /
 * `getBlockNumber` is not itself cancelled, so abort takes effect after the
 * current call settles. `viem` is a peer dependency.
 */

/**
 * The minimal viem client surface the watcher needs. Picking only the two
 * actions used (rather than the full `PublicClient`) keeps consumers immune to
 * viem-version drift in unrelated actions and lets any viem `PublicClient` pass.
 * The picked methods remain generic, so ABI-event inference still flows through.
 */
export type EventWatcherClient = Pick<PublicClient, 'getBlockNumber' | 'getLogs'>;

/** A batch of viem logs decoded against `abiEvents` (typed `args` + `eventName`). */
export type EventLogs<abiEvents extends readonly AbiEvent[]> = GetLogsReturnType<
  undefined,
  abiEvents,
  true
>;

export interface EventBatch<abiEvents extends readonly AbiEvent[]> {
  /** Decoded logs in this range. May be empty — the batch is still yielded. */
  logs: EventLogs<abiEvents>;
  /**
   * The highest block scanned in this batch (inclusive). Advance your persisted
   * cursor to here — it moves forward even across ranges that produced no logs.
   */
  toBlock: bigint;
}

export type EventPhase = 'backfill' | 'live';

export interface BackfillEventsOptions<abiEvents extends readonly AbiEvent[]> {
  client: EventWatcherClient;
  address: Address | Address[];
  /** One or more ABI event definitions to match. Must be non-empty. */
  events: abiEvents;
  /** Inclusive first block of the scan. */
  fromBlock: bigint;
  /** Inclusive last block of the scan. */
  toBlock: bigint;
  /** Block span fetched per `getLogs` call. Must be a positive bigint. */
  batchSize: bigint;
  signal?: AbortSignal;
}

export interface WatchEventsOptions<abiEvents extends readonly AbiEvent[]> {
  client: EventWatcherClient;
  address: Address | Address[];
  events: abiEvents;
  /** Block from which live polling begins (inclusive). */
  fromBlock: bigint;
  /** Max block span per `getLogs` call, so a far-behind cursor chunks the catch-up. */
  batchSize: bigint;
  /**
   * Minimum delay (ms) between polls once caught up to the tip. Default 1000.
   * Values <= 0 poll as fast as the RPC responds (no idle) — not recommended.
   */
  pollingInterval?: number;
  signal?: AbortSignal;
}

export interface StreamEventsOptions<abiEvents extends readonly AbiEvent[]> {
  client: EventWatcherClient;
  address: Address | Address[];
  events: abiEvents;
  /** Block from which the backfill begins; live tailing continues from the tip. */
  fromBlock: bigint;
  batchSize: bigint;
  pollingInterval?: number;
  signal?: AbortSignal;
}

export interface StreamItem<abiEvents extends readonly AbiEvent[]> extends EventBatch<abiEvents> {
  phase: EventPhase;
}

const DEFAULT_POLLING_INTERVAL_MS = 1_000;

function assertOptions(events: readonly AbiEvent[], batchSize: bigint): void {
  if (events.length === 0) {
    throw new Error('viem-event-watcher: `events` must contain at least one AbiEvent');
  }
  if (batchSize <= 0n) {
    throw new Error('viem-event-watcher: `batchSize` must be a positive bigint');
  }
}

// A function (vs an inline `signal?.aborted === true`) so TS doesn't flow-narrow
// the flag away after one guard — the value can change across an `await`.
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/** Resolves after `ms`, or immediately when `signal` aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Finite historical scan. Yields one {@link EventBatch} per `batchSize` chunk in
 * block order — including empty chunks, so the consumer can advance its cursor
 * across event-sparse ranges. Honours `signal` between chunks.
 */
export async function* backfillEvents<const abiEvents extends readonly AbiEvent[]>(
  options: BackfillEventsOptions<abiEvents>
): AsyncGenerator<EventBatch<abiEvents>> {
  const { client, address, events, fromBlock, toBlock, batchSize, signal } = options;
  assertOptions(events, batchSize);

  for (let start = fromBlock; start <= toBlock; start += batchSize) {
    if (isAborted(signal)) {
      return;
    }
    const span = start + batchSize - 1n;
    const end = span > toBlock ? toBlock : span;
    const logs = await client.getLogs({
      address,
      events,
      fromBlock: start,
      toBlock: end,
      strict: true
    });
    yield { logs, toBlock: end };
  }
}

/**
 * Live tail via a self-driven `getLogs` poll loop. Each iteration fetches up to
 * `batchSize` blocks and yields an {@link EventBatch} (empty or not). The tip is
 * cached and only re-fetched once the cursor catches up to it, so a multi-chunk
 * catch-up costs one `getLogs` per chunk rather than an extra `getBlockNumber`
 * each time. Because every chunk yields, backpressure holds across event-sparse
 * backlogs too. Returns when `signal` aborts; viem errors propagate by throwing.
 */
export async function* watchEvents<const abiEvents extends readonly AbiEvent[]>(
  options: WatchEventsOptions<abiEvents>
): AsyncGenerator<EventBatch<abiEvents>> {
  const { client, address, events, fromBlock, batchSize, pollingInterval, signal } = options;
  assertOptions(events, batchSize);

  const interval = pollingInterval ?? DEFAULT_POLLING_INTERVAL_MS;
  let from = fromBlock;
  let tip = await client.getBlockNumber();

  for (;;) {
    if (isAborted(signal)) {
      return;
    }
    if (from > tip) {
      // Caught up — idle, then re-probe the tip (the only place it's re-fetched).
      await delay(interval, signal);
      if (isAborted(signal)) {
        return;
      }
      tip = await client.getBlockNumber();
      continue;
    }
    const span = from + batchSize - 1n;
    const end = span > tip ? tip : span;
    const logs = await client.getLogs({
      address,
      events,
      fromBlock: from,
      toBlock: end,
      strict: true
    });
    from = end + 1n;
    yield { logs, toBlock: end };
  }
}

/**
 * Gapless backfill-then-live stream. Backfills `fromBlock`..tip, then tails from
 * `tip + 1` so no block is missed or double-scanned at the boundary. Each item
 * carries its `phase` plus the {@link EventBatch} fields. Reorg-overlap and
 * dedup remain the consumer's responsibility.
 */
export async function* streamEvents<const abiEvents extends readonly AbiEvent[]>(
  options: StreamEventsOptions<abiEvents>
): AsyncGenerator<StreamItem<abiEvents>> {
  const { client, address, events, fromBlock, batchSize, pollingInterval, signal } = options;
  assertOptions(events, batchSize); // fail fast, before any RPC round-trip

  const tip = await client.getBlockNumber();

  if (fromBlock <= tip) {
    for await (const batch of backfillEvents({
      client,
      address,
      events,
      fromBlock,
      toBlock: tip,
      batchSize,
      signal
    })) {
      yield { phase: 'backfill', ...batch };
    }
  }

  if (isAborted(signal)) {
    return;
  }

  const liveFrom = fromBlock > tip + 1n ? fromBlock : tip + 1n;
  for await (const batch of watchEvents({
    client,
    address,
    events,
    fromBlock: liveFrom,
    batchSize,
    pollingInterval,
    signal
  })) {
    yield { phase: 'live', ...batch };
  }
}
