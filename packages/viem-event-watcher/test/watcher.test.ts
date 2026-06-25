import type { AbiEvent, Log, PublicClient } from 'viem';

import { describe, expect, it, vi } from 'vitest';

import { backfillEvents, streamEvents, watchEvents } from '../src/index.ts';

const EVENT = {
  type: 'event',
  name: 'ExchangeRateUpdated',
  inputs: [{ name: 'rate', type: 'uint256', indexed: false }]
} satisfies AbiEvent;

const ADDRESS = '0x0000000000000000000000000000000000000001';

interface LogRange {
  fromBlock: bigint;
  toBlock: bigint;
}

function fakeLog(blockNumber: bigint): Log {
  // Test-only shape; the watcher treats logs as opaque batches.
  return { blockNumber, logIndex: 0, transactionHash: '0xabc' } as unknown as Log;
}

describe('backfillEvents', () => {
  it('yields one batch per chunk with its toBlock high-water-mark, including empty chunks', async () => {
    const getLogs = vi.fn(async ({ fromBlock }: LogRange) =>
      fromBlock === 0n ? [fakeLog(5n)] : []
    );
    const client = { getLogs } as unknown as PublicClient;

    const batches: { count: number; toBlock: bigint }[] = [];
    for await (const b of backfillEvents({
      client,
      address: ADDRESS,
      events: [EVENT],
      fromBlock: 0n,
      toBlock: 25n,
      batchSize: 10n
    })) {
      batches.push({ count: b.logs.length, toBlock: b.toBlock });
    }

    // Every chunk yields — including the two empty ones — so a cursor can advance.
    expect(batches).toEqual([
      { count: 1, toBlock: 9n },
      { count: 0, toBlock: 19n },
      { count: 0, toBlock: 25n }
    ]);
  });
});

describe('watchEvents', () => {
  it('yields { logs, toBlock } for the scanned range', async () => {
    const getBlockNumber = vi.fn(async () => 100n);
    const getLogs = vi.fn(async (_range: LogRange) => [fakeLog(100n)]);
    const client = { getBlockNumber, getLogs } as unknown as PublicClient;

    const gen = watchEvents({
      client,
      address: ADDRESS,
      events: [EVENT],
      fromBlock: 90n,
      batchSize: 1000n,
      pollingInterval: 5
    });
    const first = await gen.next();

    expect(first.value).toMatchObject({ toBlock: 100n });
    expect(first.value && 'logs' in first.value && first.value.logs).toHaveLength(1);
    expect(getLogs.mock.calls[0]?.[0]).toMatchObject({ fromBlock: 90n, toBlock: 100n });

    await gen.return(undefined);
  });

  it('caps a far-behind backlog to batchSize and re-fetches the tip only once', async () => {
    const getBlockNumber = vi.fn(async () => 100_000n);
    const getLogs = vi.fn(async ({ fromBlock }: LogRange) => [fakeLog(fromBlock)]);
    const client = { getBlockNumber, getLogs } as unknown as PublicClient;

    const gen = watchEvents({
      client,
      address: ADDRESS,
      events: [EVENT],
      fromBlock: 0n,
      batchSize: 10_000n,
      pollingInterval: 5
    });

    await gen.next();
    await gen.next();

    // Ranges capped to batchSize; tip cached across the catch-up (one getBlockNumber).
    expect(getLogs.mock.calls[0]?.[0]).toMatchObject({ fromBlock: 0n, toBlock: 9_999n });
    expect(getLogs.mock.calls[1]?.[0]).toMatchObject({ fromBlock: 10_000n, toBlock: 19_999n });
    expect(getBlockNumber).toHaveBeenCalledTimes(1);

    await gen.return(undefined);
  });

  it('yields empty batches during catch-up so backpressure holds over sparse ranges', async () => {
    const getBlockNumber = vi.fn(async () => 50_000n);
    const getLogs = vi.fn(async (_range: LogRange) => [] as Log[]); // no matching events
    const client = { getBlockNumber, getLogs } as unknown as PublicClient;

    const gen = watchEvents({
      client,
      address: ADDRESS,
      events: [EVENT],
      fromBlock: 0n,
      batchSize: 10_000n,
      pollingInterval: 5
    });
    const first = await gen.next();

    // The empty range is yielded (not looped past), so the consumer gates the
    // pace — exactly one getLogs has run after one pull.
    expect(first.value).toMatchObject({ toBlock: 9_999n });
    expect(first.value && 'logs' in first.value && first.value.logs).toHaveLength(0);
    expect(getLogs).toHaveBeenCalledTimes(1);

    await gen.return(undefined);
  });

  it('does not poll ahead of the consumer (backpressure)', async () => {
    const getBlockNumber = vi.fn(async () => 100n);
    const getLogs = vi.fn(async (_range: LogRange) => [fakeLog(100n)]);
    const client = { getBlockNumber, getLogs } as unknown as PublicClient;

    const gen = watchEvents({
      client,
      address: ADDRESS,
      events: [EVENT],
      fromBlock: 1n,
      batchSize: 1000n,
      pollingInterval: 5
    });
    await gen.next();

    await new Promise((r) => setTimeout(r, 40));
    expect(getLogs).toHaveBeenCalledTimes(1);

    await gen.return(undefined);
  });

  it('returns when the signal aborts', async () => {
    const controller = new AbortController();
    const getBlockNumber = vi.fn(async () => 0n); // from(1) > tip(0) → idle path, then abort
    const getLogs = vi.fn(async (_range: LogRange) => [] as Log[]);
    const client = { getBlockNumber, getLogs } as unknown as PublicClient;
    controller.abort();

    const gen = watchEvents({
      client,
      address: ADDRESS,
      events: [EVENT],
      fromBlock: 1n,
      batchSize: 1000n,
      pollingInterval: 5,
      signal: controller.signal
    });
    const result = await gen.next();

    expect(result.done).toBe(true);
  });
});

describe('streamEvents', () => {
  it('fails fast on a bad batchSize before any RPC call', async () => {
    const getBlockNumber = vi.fn(async () => 50n);
    const client = { getBlockNumber, getLogs: vi.fn() } as unknown as PublicClient;

    const gen = streamEvents({
      client,
      address: ADDRESS,
      events: [EVENT],
      fromBlock: 0n,
      batchSize: 0n
    });

    await expect(gen.next()).rejects.toThrow('batchSize');
    expect(getBlockNumber).not.toHaveBeenCalled();
  });

  it('backfills to tip then tails live with no gap, tagging each phase', async () => {
    const tips = [50n, 51n, 51n];
    let tipCall = 0;
    const getBlockNumber = vi.fn(async () => tips[Math.min(tipCall++, tips.length - 1)] ?? 51n);
    const getLogs = vi.fn(async ({ fromBlock }: LogRange) => {
      if (fromBlock === 0n) return [fakeLog(10n)];
      if (fromBlock === 51n) return [fakeLog(51n)];
      return [];
    });
    const client = { getBlockNumber, getLogs } as unknown as PublicClient;

    const gen = streamEvents({
      client,
      address: ADDRESS,
      events: [EVENT],
      fromBlock: 0n,
      batchSize: 100n,
      pollingInterval: 5
    });

    const first = await gen.next();
    const second = await gen.next();

    expect(first.value).toMatchObject({ phase: 'backfill', toBlock: 50n });
    expect(second.value).toMatchObject({ phase: 'live', toBlock: 51n });
    expect(getLogs.mock.calls.some((c) => c[0]?.fromBlock === 51n)).toBe(true);

    await gen.return(undefined);
  });
});
