import type { AddressInfo } from 'node:net';

import http from 'node:http';

import { Contract, FetchRequest, JsonRpcProvider, Network } from 'ethers';
import ethersV5 from 'ethers-v5';
import { createPublicClient, http as viemHttp } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serializeError, VError } from '../src/verror.ts';

/**
 * End-to-end leak regression: drives the *real* ethers v5, ethers v6 and
 * viem clients against a local node that fails in every way a node fails,
 * and asserts no credential reaches the serialised error.
 *
 * Hand-written error fixtures cannot answer "does a key leak?" — they only
 * prove the sanitiser handles the shape the author imagined. Two real leaks
 * were found this way and would not have been found otherwise: viem's
 * `TimeoutError` fell outside the fingerprint, and ethers v5 nests its
 * inner error under `.error` rather than `.cause`, hiding the node that
 * carried the URL. Re-run this whenever the sanitiser changes or any of the
 * three clients takes a major bump.
 *
 * The credential is planted in all three places a gateway puts one: the URL
 * path (our node gateway's style), the query string, and a request header.
 *
 * Out of scope, deliberately: a provider that prints a bare, non-URL secret
 * as prose inside its own response body. `stripUrlsInPlace` rewrites URLs;
 * it cannot recognise an arbitrary credential in free text, and response
 * bodies are carried by design (ethers v6 exposes `info.responseBody`).
 */
const PATH_KEY = 'PATHKEY-9f2b41c8';
const QUERY_TOKEN = 'QUERYTOKEN-77ab3e10';
const AUTH_HEADER = 'AUTHBEARER-c41d9f22';
const SECRETS = { PATH_KEY, QUERY_TOKEN, AUTH_HEADER };

const ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'a', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  }
] as const;
const ADDRESS = '0x1111111111111111111111111111111111111111';
const CLIENT_TIMEOUT_MS = 400;

type Mode =
  | 'unauthorised'
  | 'rateLimited'
  | 'serverErrorHtml'
  | 'gatewayTimeoutEmpty'
  | 'malformedJson'
  | 'jsonRpcError'
  | 'revert'
  | 'connectionReset'
  | 'slow';

/**
 * Fails the way a node fails. `eth_chainId` is always answered so each
 * client gets past its handshake and issues the call under test.
 */
function createNode(mode: Mode): http.Server {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const parsed: unknown = raw === '' ? {} : JSON.parse(raw);
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      const call = (first ?? {}) as { id?: number; method?: string };
      const id = call.id ?? 1;

      const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };

      if (call.method === 'eth_chainId' && mode !== 'connectionReset' && mode !== 'slow') {
        send(200, { jsonrpc: '2.0', id, result: '0x1' });
        return;
      }

      switch (mode) {
        case 'unauthorised':
          send(401, { error: { code: -32001, message: 'unauthorized' } });
          return;
        case 'rateLimited':
          // Alongside the retry hints, two response headers that must be
          // dropped and one that echoes the tokenised URL back at us.
          send(
            429,
            { error: { code: -32005, message: 'rate limit exceeded' } },
            {
              'retry-after': '30',
              'credits-rate-reset': '12',
              'x-request-id': 'req-8f21',
              'set-cookie': `sess=${PATH_KEY}`,
              'x-api-key': PATH_KEY,
              'x-upstream-url': `http://127.0.0.1:1/rpc/${PATH_KEY}?token=${QUERY_TOKEN}`
            }
          );
          return;
        case 'serverErrorHtml':
          send(500, '<html><body>upstream failure</body></html>', { 'content-type': 'text/html' });
          return;
        case 'gatewayTimeoutEmpty':
          res.writeHead(504, { 'content-type': 'application/json' });
          res.end();
          return;
        case 'malformedJson':
          send(200, '{ not json ');
          return;
        case 'jsonRpcError':
          send(200, { jsonrpc: '2.0', id, error: { code: -32000, message: 'internal error' } });
          return;
        case 'revert':
          // No `data`: the shape that makes ethers v5 raise a real
          // CALL_EXCEPTION wrapping the fetch error under `.error`.
          send(200, {
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: 'execution reverted: Insufficient balance' }
          });
          return;
        case 'connectionReset':
          res.socket?.destroy();
          return;
        case 'slow':
          setTimeout(() => send(200, { jsonrpc: '2.0', id, result: '0x1' }), CLIENT_TIMEOUT_MS * 8);
          return;
      }
    });
  });
}

/** Every secret found anywhere in a serialised structure. */
function leaks(value: unknown, found = new Set<string>(), seen = new Set<object>()): string[] {
  if (typeof value === 'string') {
    for (const [name, secret] of Object.entries(SECRETS)) {
      if (value.includes(secret)) found.add(name);
    }
    return [...found];
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return [...found];
  seen.add(value);
  for (const nested of Object.values(value)) leaks(nested, found, seen);
  return [...found];
}

const CLIENTS = {
  'ethers v5': async ({ url, revert }: { url: string; revert: boolean }): Promise<unknown> => {
    const provider = new ethersV5.providers.StaticJsonRpcProvider(
      { url, headers: { authorization: `Bearer ${AUTH_HEADER}` }, timeout: CLIENT_TIMEOUT_MS },
      1
    );
    if (revert) return new ethersV5.Contract(ADDRESS, ABI, provider).balanceOf(ADDRESS);
    return provider.getBlockNumber();
  },
  'ethers v6': async ({ url, revert }: { url: string; revert: boolean }): Promise<unknown> => {
    const request = new FetchRequest(url);
    request.setHeader('authorization', `Bearer ${AUTH_HEADER}`);
    request.timeout = CLIENT_TIMEOUT_MS;
    const provider = new JsonRpcProvider(request, Network.from(1), {
      staticNetwork: true,
      batchMaxCount: 1
    });
    if (revert) return new Contract(ADDRESS, ABI, provider).balanceOf(ADDRESS);
    return provider.getBlockNumber();
  },
  viem: async ({ url, revert }: { url: string; revert: boolean }): Promise<unknown> => {
    const client = createPublicClient({
      transport: viemHttp(url, {
        timeout: CLIENT_TIMEOUT_MS,
        retryCount: 0,
        fetchOptions: { headers: { authorization: `Bearer ${AUTH_HEADER}` } }
      })
    });
    if (revert) {
      return client.readContract({
        address: ADDRESS,
        abi: ABI,
        functionName: 'balanceOf',
        args: [ADDRESS]
      });
    }
    return client.getBlockNumber();
  }
} as const;

const MODES: Mode[] = [
  'unauthorised',
  'rateLimited',
  'serverErrorHtml',
  'gatewayTimeoutEmpty',
  'malformedJson',
  'jsonRpcError',
  'revert',
  'connectionReset',
  'slow'
];

describe('RPC credential leaks — real clients against a failing node', { timeout: 30000 }, () => {
  let server!: http.Server;
  let url!: string;

  const start = async (mode: Mode): Promise<void> => {
    server = createNode(mode);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}/rpc/${PATH_KEY}?token=${QUERY_TOKEN}`;
  };
  const stop = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  for (const mode of MODES) {
    describe(mode, () => {
      beforeAll(async () => start(mode));
      afterAll(stop);

      for (const [client, call] of Object.entries(CLIENTS)) {
        it(`${client}: no credential survives serialisation`, async () => {
          let caught: unknown;
          try {
            await call({ url, revert: mode === 'revert' });
          } catch (error) {
            caught = error;
          }
          // ethers v5 decodes some error responses into a result rather than
          // throwing; nothing to assert when the call resolved.
          if (!(caught instanceof Error)) return;

          // The raw error is expected to carry the credential — that is the
          // whole reason the sanitiser exists. Guards the fixture itself:
          // if this stops holding, the scenario stopped exercising the leak.
          const wrapped = new VError('fetching block number', {
            cause: caught,
            info: { attempt: 1 }
          });
          expect(leaks(serializeError(caught))).deep.equal([]);
          expect(leaks(serializeError(wrapped))).deep.equal([]);
          expect(leaks(JSON.parse(JSON.stringify(wrapped)))).deep.equal([]);
        });
      }
    });
  }
});

describe('RPC credential leaks — the unsanitised error really does carry the secret', () => {
  // Without this, every assertion above could pass because the scenarios
  // stopped reaching the node at all.
  let server!: http.Server;
  let url!: string;

  beforeAll(async () => {
    server = createNode('rateLimited');
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}/rpc/${PATH_KEY}?token=${QUERY_TOKEN}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('ethers v6 raw error carries the URL credentials before sanitisation', async () => {
    const request = new FetchRequest(url);
    request.timeout = CLIENT_TIMEOUT_MS;
    const provider = new JsonRpcProvider(request, Network.from(1), {
      staticNetwork: true,
      batchMaxCount: 1
    });
    let caught: unknown;
    try {
      await provider.getBlockNumber();
    } catch (error) {
      caught = error;
    }
    expect(caught).instanceOf(Error);
    expect(leaks(caught)).members(['PATH_KEY', 'QUERY_TOKEN']);
  });
});
