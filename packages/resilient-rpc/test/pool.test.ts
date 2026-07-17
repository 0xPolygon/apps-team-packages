import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RpcPool, RpcPoolEvent } from '../src/types.ts';

import { RpcHttpStatusError } from '../src/errors.ts';
import { createRpcPool } from '../src/pool.ts';
import { captureRejection, makeLogger, scriptedWire, transportError } from './helpers.ts';

const CHAIN_ID = 137;
const A = 'https://rpc-a.example';
const B = 'https://rpc-b.example';
// Token in the query string: assertions below prove only origins ever
// reach logs, snapshots and error info.
const ENDPOINTS = [{ url: `${A}/v1?token=secret-a` }, { url: `${B}/v1` }];

const openedPools: RpcPool[] = [];

const makePool = (args: {
  wire: Parameters<typeof createRpcPool>[0]['rawRequest'];
  endpoints?: { url: string }[];
  logger: ReturnType<typeof makeLogger>['logger'];
  policy?: Parameters<typeof createRpcPool>[0]['policy'];
  circuitBreaker?: Parameters<typeof createRpcPool>[0]['circuitBreaker'];
  onEvent?: (event: RpcPoolEvent) => void;
}): RpcPool => {
  const pool = createRpcPool({
    chainId: CHAIN_ID,
    endpoints: args.endpoints ?? ENDPOINTS,
    logger: args.logger,
    rawRequest: args.wire,
    ...(args.policy ? { policy: args.policy } : {}),
    ...(args.circuitBreaker ? { circuitBreaker: args.circuitBreaker } : {}),
    ...(args.onEvent ? { onEvent: args.onEvent } : {})
  });
  openedPools.push(pool);
  return pool;
};

afterEach(() => {
  for (const pool of openedPools.splice(0)) pool.close();
  vi.useRealTimers();
});

describe('priority routing', () => {
  it('serves every request from endpoint 0 while it is healthy', async () => {
    const { logger } = makeLogger();
    const { wire, calls } = scriptedWire({
      [A]: async () => 'from-a',
      [B]: async () => 'from-b'
    });
    const pool = makePool({ wire, logger });
    expect(await pool.request({ method: 'eth_blockNumber' })).equal('from-a');
    expect(await pool.request({ method: 'eth_blockNumber' })).equal('from-a');
    expect(calls).deep.equal([A, A]);
  });

  it('fails over to the next endpoint with zero sleep on a transport error', async () => {
    vi.useFakeTimers();
    const { logger, warn } = makeLogger();
    const { wire, calls } = scriptedWire({
      [A]: async () => {
        throw transportError('ECONNREFUSED');
      },
      [B]: async () => 'from-b'
    });
    const pool = makePool({ wire, logger });
    // Resolves without any timer advancing — the failover slept for 0ms.
    expect(await pool.request({ method: 'eth_blockNumber' })).equal('from-b');
    expect(calls).deep.equal([A, B]);
    expect(warn.mock.calls).lengthOf(1);
    expect(warn.mock.calls[0]?.[0]).property('endpoint', A);
    expect(warn.mock.calls[0]?.[0]).property('attempt', 1);
  });
});

describe('circuit breaker state machine', () => {
  it('opens after the configured consecutive transport failures and logs RpcEndpointDegradedError', async () => {
    const { logger, error } = makeLogger();
    const events: RpcPoolEvent[] = [];
    const { wire } = scriptedWire({
      [A]: async () => {
        throw transportError('ECONNRESET');
      },
      [B]: async () => 'from-b'
    });
    const pool = makePool({ wire, logger, onEvent: (event) => events.push(event) });

    for (let i = 0; i < 3; i++) {
      expect(await pool.request({ method: 'eth_blockNumber' })).equal('from-b');
    }

    expect(pool.snapshot()[0]).property('state', 'OPEN');
    expect(pool.snapshot()[0]).property('openSinceMs');
    expect(error.mock.calls).lengthOf(1);
    const logged = error.mock.calls[0]?.[0];
    expect(logged).nested.property('err.name', 'RpcEndpointDegradedError');
    expect(logged).nested.property('err.info.endpoint', A);
    expect(logged).nested.property('err.info.chainId', CHAIN_ID);
    expect(logged).nested.property('err.info.consecutiveFailures', 3);
    expect(logged).nested.property('err.info.healthyEndpoints', 1);
    expect(logged).nested.property('err.info.totalEndpoints', 2);
    expect(events.filter((e) => e.type === 'endpoint-opened')).lengthOf(1);
  });

  it('routes only to healthy endpoints while a circuit is open', async () => {
    const { logger } = makeLogger();
    let aHealthy = true;
    const { wire, calls } = scriptedWire({
      [A]: async () => {
        if (!aHealthy) throw transportError('ECONNREFUSED');
        return 'from-a';
      },
      [B]: async () => 'from-b'
    });
    const pool = makePool({ wire, logger, circuitBreaker: { openAfterConsecutiveFailures: 1 } });
    aHealthy = false;
    expect(await pool.request({ method: 'eth_blockNumber' })).equal('from-b'); // opens A
    calls.length = 0;
    expect(await pool.request({ method: 'eth_blockNumber' })).equal('from-b');
    expect(calls).deep.equal([B]);
  });

  it('closes the circuit when a background probe succeeds with the right chain id', async () => {
    vi.useFakeTimers();
    const { logger, info } = makeLogger();
    const events: RpcPoolEvent[] = [];
    let aHealthy = false;
    const { wire } = scriptedWire({
      [A]: async ({ method }) => {
        if (!aHealthy) throw transportError('ECONNREFUSED');
        return method === 'eth_chainId' ? '0x89' : 'from-a';
      },
      [B]: async () => 'from-b'
    });
    const pool = makePool({
      wire,
      logger,
      circuitBreaker: {
        openAfterConsecutiveFailures: 1,
        probe: { initialDelayMs: 1000, jitter: false }
      },
      onEvent: (event) => events.push(event)
    });

    expect(await pool.request({ method: 'eth_blockNumber' })).equal('from-b'); // opens A
    expect(pool.snapshot()[0]).property('state', 'OPEN');

    aHealthy = true;
    await vi.advanceTimersByTimeAsync(1000);

    expect(pool.snapshot()[0]).property('state', 'CLOSED');
    expect(pool.snapshot()[0]).property('consecutiveFailures', 0);
    expect(events.filter((e) => e.type === 'endpoint-recovered')).lengthOf(1);
    expect(info.mock.calls).lengthOf(1);
    expect(info.mock.calls[0]?.[0]).property('endpoint', A);
    expect(info.mock.calls[0]?.[0]).property('downtimeMs');
    // recovered: routed to A again
    expect(await pool.request({ method: 'eth_blockNumber' })).equal('from-a');
  });

  it('keeps the circuit open when the probe answers with the wrong chain id', async () => {
    vi.useFakeTimers();
    const { logger, error } = makeLogger();
    const events: RpcPoolEvent[] = [];
    const { wire } = scriptedWire({
      [A]: async ({ method }) => {
        if (method === 'eth_chainId') return '0x1'; // wrong chain behind the URL
        throw transportError('ECONNREFUSED');
      },
      [B]: async () => 'from-b'
    });
    const pool = makePool({
      wire,
      logger,
      circuitBreaker: {
        openAfterConsecutiveFailures: 1,
        probe: { initialDelayMs: 1000, jitter: false }
      },
      onEvent: (event) => events.push(event)
    });

    expect(await pool.request({ method: 'eth_blockNumber' })).equal('from-b'); // opens A
    await vi.advanceTimersByTimeAsync(1000);

    expect(pool.snapshot()[0]).property('state', 'OPEN');
    expect(events.filter((e) => e.type === 'probe-failed')).lengthOf(1);
    // open + failed re-probe, both at error level with the degraded class
    expect(error.mock.calls).lengthOf(2);
    expect(error.mock.calls[1]?.[0]).nested.property('err.name', 'RpcEndpointDegradedError');
    expect(error.mock.calls[1]?.[0]).nested.property('err.info.downtimeMs');
    // next probe is rescheduled with exponential backoff
    expect(vi.getTimerCount()).greaterThan(0);
  });

  it('close() stops pending probe timers', async () => {
    vi.useFakeTimers();
    const { logger } = makeLogger();
    const { wire } = scriptedWire({
      [A]: async () => {
        throw transportError('ECONNREFUSED');
      },
      [B]: async () => 'from-b'
    });
    const pool = makePool({ wire, logger, circuitBreaker: { openAfterConsecutiveFailures: 1 } });
    expect(await pool.request({ method: 'eth_blockNumber' })).equal('from-b');
    expect(vi.getTimerCount()).greaterThan(0);
    pool.close();
    expect(vi.getTimerCount()).equal(0);
  });
});

describe('error classification at the routing boundary', () => {
  it('passes application-class errors (revert) through untouched with no health impact', async () => {
    const { logger, warn } = makeLogger();
    const revert = Object.assign(new Error('execution reverted: NotOwner()'), { code: 3 });
    const { wire, calls } = scriptedWire({
      [A]: async () => {
        throw revert;
      },
      [B]: async () => 'from-b'
    });
    const pool = makePool({ wire, logger });
    const caught = await captureRejection(pool.request({ method: 'eth_call' }));
    expect(caught).equal(revert); // the exact native error instance
    expect(calls).deep.equal([A]); // no failover
    expect(warn.mock.calls).lengthOf(0);
    expect(pool.snapshot()[0]).property('consecutiveFailures', 0);
  });

  it('passes -32602 invalid params through without retry', async () => {
    const { logger } = makeLogger();
    const invalidParams = Object.assign(new Error('invalid argument 0'), { code: -32602 });
    const { wire, calls } = scriptedWire({
      [A]: async () => {
        throw invalidParams;
      },
      [B]: async () => 'from-b'
    });
    const pool = makePool({ wire, logger });
    expect(await captureRejection(pool.request({ method: 'eth_call' }))).equal(invalidParams);
    expect(calls).deep.equal([A]);
  });

  it('fails over on borderline errors (HTTP 429) without counting toward opening', async () => {
    const { logger, warn } = makeLogger();
    const { wire, calls } = scriptedWire({
      [A]: async () => {
        throw new RpcHttpStatusError({ status: 429 });
      },
      [B]: async () => 'from-b'
    });
    const pool = makePool({ wire, logger });
    expect(await pool.request({ method: 'eth_blockNumber' })).equal('from-b');
    expect(calls).deep.equal([A, B]);
    expect(warn.mock.calls).lengthOf(1);
    expect(pool.snapshot()[0]).property('consecutiveFailures', 0);
  });
});

describe('exhaustion and degraded operation', () => {
  it('throws RpcRequestFailedError with chainId/attempts/endpoints after exhausting attempts', async () => {
    const { logger, warn, error } = makeLogger();
    const { wire } = scriptedWire({
      [A]: async () => {
        throw transportError('ECONNREFUSED');
      },
      [B]: async () => {
        throw transportError('ETIMEDOUT');
      }
    });
    const pool = makePool({ wire, logger });
    const caught = await captureRejection(pool.request({ method: 'eth_blockNumber' }));
    expect(caught).property('name', 'RpcRequestFailedError');
    expect(caught).nested.property('info.chainId', CHAIN_ID);
    expect(caught).nested.property('info.attempts', 3); // endpoints + 1
    expect(caught).nested.property('info.endpoints').deep.equal([A, B, A]);
    expect(caught).property('cause').instanceOf(Error);
    // retried attempts warn; the terminal throw is NOT logged by the pool
    expect(warn.mock.calls).lengthOf(2);
    expect(error.mock.calls).lengthOf(0);
  });

  it('backs off between consecutive attempts on the same endpoint when nothing else is healthy', async () => {
    vi.useFakeTimers();
    const { logger } = makeLogger();
    const { wire, calls } = scriptedWire({
      [A]: async () => {
        throw transportError('ECONNREFUSED');
      }
    });
    const pool = makePool({
      wire,
      logger,
      endpoints: [{ url: `${A}/v1` }],
      policy: { sameEndpointBackoff: { baseMs: 500, jitter: false } },
      circuitBreaker: { openAfterConsecutiveFailures: 10 }
    });
    const outcome = captureRejection(pool.request({ method: 'eth_blockNumber' }));
    await vi.advanceTimersByTimeAsync(0); // first attempt fails; backoff timer armed
    expect(calls).lengthOf(1);
    expect(vi.getTimerCount()).greaterThan(0);
    await vi.advanceTimersByTimeAsync(500); // second attempt runs after the backoff
    expect(await outcome).property('name', 'RpcRequestFailedError');
    expect(calls).lengthOf(2);
  });

  it('runs last-resort rotation and emits RpcAllEndpointsDownError when every circuit is open', async () => {
    const { logger, error } = makeLogger();
    const events: RpcPoolEvent[] = [];
    let bHealthy = false;
    const { wire } = scriptedWire({
      [A]: async () => {
        throw transportError('ECONNREFUSED');
      },
      [B]: async () => {
        if (!bHealthy) throw transportError('ECONNREFUSED');
        return 'from-b';
      }
    });
    const pool = makePool({
      wire,
      logger,
      circuitBreaker: { openAfterConsecutiveFailures: 1 },
      onEvent: (event) => events.push(event)
    });

    // Opens both circuits, then exhausts via last-resort rotation.
    const caught = await captureRejection(pool.request({ method: 'eth_blockNumber' }));
    expect(caught).property('name', 'RpcRequestFailedError');
    expect(events.filter((e) => e.type === 'all-endpoints-down')).lengthOf(1);
    const allDownLogs = error.mock.calls.filter(
      (call) =>
        call[0] !== null &&
        typeof call[0] === 'object' &&
        'err' in call[0] &&
        call[0].err instanceof Error &&
        call[0].err.name === 'RpcAllEndpointsDownError'
    );
    expect(allDownLogs).lengthOf(1);

    // A last-resort success closes that endpoint's circuit directly.
    bHealthy = true;
    expect(await pool.request({ method: 'eth_blockNumber' })).equal('from-b');
    expect(pool.snapshot()[1]).property('state', 'CLOSED');
    expect(events.filter((e) => e.type === 'endpoint-recovered')).lengthOf(1);
  });

  it('never retries or fails over eth_sendTransaction', async () => {
    const { logger } = makeLogger();
    const { wire, calls } = scriptedWire({
      [A]: async () => {
        throw transportError('ECONNREFUSED');
      },
      [B]: async () => '0xhash'
    });
    const pool = makePool({ wire, logger });
    const caught = await captureRejection(pool.request({ method: 'eth_sendTransaction' }));
    expect(caught).property('name', 'RpcRequestFailedError');
    expect(calls).deep.equal([A]);
  });
});

describe('snapshot', () => {
  it('exposes per-endpoint origin/state/failures/lastSuccess for /service-status', async () => {
    const { logger } = makeLogger();
    const { wire } = scriptedWire({ [A]: async () => 'ok', [B]: async () => 'ok' });
    const pool = makePool({ wire, logger });
    await pool.request({ method: 'eth_blockNumber' });
    const snapshot = pool.snapshot();
    expect(snapshot).lengthOf(2);
    // origins only — the ?token=… query string never appears
    expect(snapshot[0]).property('origin', A);
    expect(snapshot[0]).property('state', 'CLOSED');
    expect(snapshot[0]).property('consecutiveFailures', 0);
    expect(snapshot[0]?.lastSuccessMs).a('number');
    expect(snapshot[0]).not.property('openSinceMs');
    expect(snapshot[1]).property('lastSuccessMs', null);
  });
});
