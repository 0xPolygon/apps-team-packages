import { describe, expect, it } from 'vitest';

import type { RpcPool, RpcRequestArgs } from '../src/types.ts';

import { JsonRpcResponseError } from '../src/errors.ts';
import { ResilientJsonRpcProvider } from '../src/ethers/index.ts';
import { captureRejection } from './helpers.ts';

const fakePool = (
  handler: (args: RpcRequestArgs) => Promise<unknown>
): { pool: RpcPool; methods: string[] } => {
  const methods: string[] = [];
  const pool: RpcPool = {
    chainId: 137,
    endpoints: [{ index: 0, url: 'https://rpc-a.example/v1', origin: 'https://rpc-a.example' }],
    attemptTimeoutMs: 10_000,
    request: async (args) => {
      methods.push(args.method);
      return handler(args);
    },
    snapshot: () => [],
    close: () => undefined
  };
  return { pool, methods };
};

describe('ResilientJsonRpcProvider', () => {
  it('serves requests through the pool with a statically pinned network', async () => {
    const { pool, methods } = fakePool(async ({ method }) => {
      if (method === 'eth_blockNumber') return '0x2a';
      throw new Error(`unexpected method ${method}`);
    });
    const provider = new ResilientJsonRpcProvider(pool, { batchStallTime: 0 });
    try {
      expect(await provider.getBlockNumber()).equal(42);
      // static network: no eth_chainId detection round-trip
      expect(methods).deep.equal(['eth_blockNumber']);
      expect((await provider.getNetwork()).chainId).equal(137n);
    } finally {
      provider.destroy();
    }
  });

  it('maps JSON-RPC error responses back into native ethers errors', async () => {
    const { pool } = fakePool(async () => {
      throw new JsonRpcResponseError({ code: -32602, message: 'invalid params' });
    });
    const provider = new ResilientJsonRpcProvider(pool, { batchStallTime: 0 });
    try {
      // Not eth_call: ethers' getRpcError special-cases it and inspects the
      // tx params, which would test ethers, not the adapter's mapping.
      const caught = await captureRejection(
        provider.send('eth_getBalance', ['0x0000000000000000000000000000000000000000'])
      );
      expect(caught).instanceOf(Error);
      expect(String(caught)).match(/invalid params/);
    } finally {
      provider.destroy();
    }
  });

  it('propagates pool transport exhaustion as a throw', async () => {
    const failure = new Error('exhausted');
    const { pool } = fakePool(async () => {
      throw failure;
    });
    const provider = new ResilientJsonRpcProvider(pool, { batchStallTime: 0 });
    try {
      const caught = await captureRejection(provider.send('eth_blockNumber', []));
      expect(caught).instanceOf(Error);
    } finally {
      provider.destroy();
    }
  });
});
