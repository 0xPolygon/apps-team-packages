# Migration Guide

## Adopting `@polygonlabs/viem-event-watcher` (replacing servercore's `EventConsumer`)

This package replaces the `EventConsumer` from the old `@polygonlabs/servercore`
package (now removed). The behaviour is the same — backfill historical logs, then
tail the tip — but the shape is inverted: an **async generator you pull from**
instead of an **observer object the consumer pushes into**. That change is the
point. The old design hid the cursor, restart policy, and logging inside the
consumer; the new one hands all three back to your code, where they belong, and
the generators are generic over the ABI event tuple so the logs you receive are
fully typed.

### What changed, at a glance

| Old (`servercore` `EventConsumer`) | New (`viem-event-watcher`) |
| --- | --- |
| `new EventConsumer(config).start(observer)` | `for await (const batch of streamEvents(options))` |
| `IObserver` with `next` / `summary` / `error` / `closed` | the loop body (`next`), a `try/catch` (`error`), and your own restart loop (`closed`) |
| `IEventConsumerConfig` (`events: AbiEvent[]`) | `StreamEventsOptions` (`events: readonly AbiEvent[]`, pass `as const`) |
| `rpcUrl` — client built internally per consumer | `client` — you build one viem `PublicClient` and reuse it |
| `startBlock` / `pollBatchSize` / `pollInterval` | `fromBlock` / `batchSize` / `pollingInterval` |
| `nativeCurrency` | _(dropped — it played no part in log decoding)_ |
| `isBackfillingInProcess` getter | `phase === 'backfill'` on each yielded item |
| logs typed as `IEventLog[]`; event name re-derived from topic via `toEventSelector` | `log.eventName` discriminant + typed `log.args`, decoded by viem |
| `ConsumerError` / `ExternalDependencyError` (bespoke) | the generator just **throws**; wrap with `VError` at your boundary |
| internal `Logger` singleton | no logging in the library — inject your logger, log once at the `catch` |
| cursor advances only on event-bearing batches | advance to `batch.toBlock` every batch (empty ranges included) |

### Step 1 — Swap the dependency

```bash
pnpm remove @polygonlabs/servercore
pnpm add @polygonlabs/viem-event-watcher viem
```

`viem` is a peer dependency, so declare it as a direct dependency of your
service.

### Step 2 — Convert the config

`events` must be a `readonly` tuple (`as const`, or a `satisfies` against your
own config type) for the typed-`args` / `eventName` inference to flow through.
Drop `nativeCurrency`; rename the poll fields.

```ts
// Before — IEventConsumerConfig
const config: IEventConsumerConfig = {
  contractAddress,
  events,            // AbiEvent[]
  chainId,
  rpcUrl,
  nativeCurrency,    // unused for decoding
  startBlock,
  pollBatchSize,
  pollInterval
};

// After — your own config, plus a reused client
const events = [/* ... */] as const; // tuple → typed logs
const client = createPublicClient({ transport: http(rpcUrl) });
```

### Step 3 — Replace `start(observer)` with a pull loop

The observer's four callbacks map onto plain control flow:

- `next(batch)` → the body of the `for await`.
- `error(err)` → a `try/catch` around the loop. Log once here (the outermost
  boundary), wrapping with `VError` if you need to attach context — never
  log-then-throw inside the loop.
- `closed()` → your own restart loop. The generator ending (or throwing) drops
  out of the `for await`; loop back, re-read the cursor, and re-enter.
- `summary()` → gone. It was a no-op in practice; remove it.

```ts
// Before — observer injection + closed-callback restart
this.eventConsumer = new EventConsumer(this.consumerConfig);
await this.eventConsumer.start({
  next: async (eventLog) => this.onEvent(eventLog),
  summary: async () => {},
  error: (err) => this.onError(err),
  closed: () => {
    this.eventConsumer = null;
    void this.start(); // restart
  }
});

// After — consumer-owned restart loop with AbortController
private async runLoop(): Promise<void> {
  while (!this.stopped) {
    const controller = new AbortController();
    this.attempt = controller;
    try {
      const fromBlock = await this.resumeFromBlock();
      for await (const { phase, logs, toBlock } of streamEvents({
        client: this.client,
        address: this.consumerConfig.contractAddress,
        events: this.consumerConfig.events,
        fromBlock,
        batchSize: this.consumerConfig.pollBatchSize,
        pollingInterval: this.consumerConfig.pollInterval,
        signal: controller.signal
      })) {
        this.backfilling = phase === 'backfill'; // was isBackfillingInProcess
        await this.onEvent(logs, toBlock);
      }
    } catch (error) {
      // The stream surfaces failures by throwing; log once here and restart.
      this.logger.warn({ err: error as Error }, 'Consumer error — restarting');
    }
    if (!this.stopped) {
      await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
    }
  }
}

public stop(): void {
  this.stopped = true;
  this.attempt?.abort(); // ends the current stream between viem calls
}
```

### Step 4 — Use the typed `eventName` and advance the cursor every batch

viem decodes each log, so narrow on `log.eventName` instead of building a
topic-selector map, and read `log.args.<field>` with full types — the
`IEventLog` shape and the `toEventSelector` lookup are no longer needed.

Advance your persisted cursor to `toBlock` after **every** batch, including
empty ones. The old consumer only moved the cursor on event-bearing batches; the
high-water-mark moves it forward across quiet ranges too, so a long stretch with
no matching events no longer re-scans on restart.

```ts
private async onEvent(logs: EventLogs<TransactionEvents>, toBlock: bigint): Promise<void> {
  for (const event of logs) {
    if (event.eventName === 'sPOLMinted') {
      // event.args is typed for sPOLMinted
    } else if (event.eventName === 'sPOLBurned') {
      // event.args is typed for sPOLBurned — e.g. Number(event.args.nonce)
    }
  }
  // Advance to the scanned high-water-mark — moves forward even across ranges
  // that produced no matching logs.
  await this.metadataStore.updateLastProcessedBlockNum(this.chainId, Number(toBlock));
}
```

### Step 5 — Drop the bespoke errors and the internal logger

`ConsumerError` / `ExternalDependencyError` have no replacement in this package —
the generator throws the underlying error directly. Catch it at your restart
boundary and wrap with `@polygonlabs/verror` if you need to attach context. The
library logs nothing; pass your own logger into the consumer and log once, at the
`catch`.
