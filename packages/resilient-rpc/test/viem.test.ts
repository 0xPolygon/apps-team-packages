import { describe, expect, it } from 'vitest';

import type { RpcPool, RpcRequestArgs } from '../src/types.ts';

import { resilientTransport } from '../src/viem/index.ts';

const fakePool = (): { pool: RpcPool; requests: RpcRequestArgs[] } => {
  const requests: RpcRequestArgs[] = [];
  const pool: RpcPool = {
    chainId: 137,
    endpoints: [{ index: 0, url: 'https://rpc-a.example/v1', origin: 'https://rpc-a.example' }],
    attemptTimeoutMs: 1234,
    request: async (args) => {
      requests.push(args);
      return '0x10';
    },
    snapshot: () => [],
    close: () => undefined
  };
  return { pool, requests };
};

describe('resilientTransport', () => {
  it('creates a transport with inner retries off and the pool-aligned timeout', () => {
    const { pool } = fakePool();
    const transport = resilientTransport(pool)({});
    expect(transport.config).property('type', 'resilientRpc');
    expect(transport.config).property('retryCount', 0);
    expect(transport.config).property('timeout', 1234);
  });

  it('routes requests through the pool and attaches a viem raw wire for failover', async () => {
    const { pool, requests } = fakePool();
    const transport = resilientTransport(pool)({});
    const result = await transport.request({ method: 'eth_blockNumber' });
    expect(result).equal('0x10');
    expect(requests).lengthOf(1);
    expect(requests[0]).property('method', 'eth_blockNumber');
    // The per-endpoint viem `http` wire rides along so the pool can retry
    // each attempt over viem's own wire layer.
    expect(requests[0]?.rawRequest).a('function');
  });
});
