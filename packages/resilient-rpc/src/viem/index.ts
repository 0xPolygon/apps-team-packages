import type { EIP1193RequestFn, Transport } from 'viem';

import { createTransport, http } from 'viem';

import type { RawRequest, RpcPool } from '../types.ts';

/**
 * viem's `EIP1193RequestFn` is generic in its return type, which no concrete
 * implementation can satisfy without asserting — viem's own `http` transport
 * returns `any` internally for the same reason. This is the package's single
 * third-party-forced assertion, isolated at this boundary per team policy.
 */
const asEip1193RequestFn = (
  fn: (args: { method: string; params?: unknown }) => Promise<unknown>
): EIP1193RequestFn => fn as EIP1193RequestFn;

/**
 * A viem `Transport` backed by a resilient RPC pool — a drop-in where viem's
 * `fallback` would go, but with a per-endpoint circuit breaker and a
 * log-driven degrade signal, which `fallback` lacks.
 *
 * The wire layer is viem's own: one `http` transport per pool endpoint with
 * inner retries OFF (`retryCount: 0`) and the per-request timeout matching
 * the pool's attempt deadline — the pool owns retry, failover and deadlines,
 * so viem must never multiply attempts underneath it. Native viem errors
 * (`HttpRequestError`, `RpcRequestError`, …) flow back into the pool's
 * classifier untouched.
 *
 * TODO (deferred from v1): validate interaction with `batch: true` clients —
 * batching aggregates several logical calls into one wire request, which
 * makes per-call failover semantics murkier.
 */
export const resilientTransport = (pool: RpcPool): Transport<'resilientRpc'> => {
  return ({ chain }) => {
    const makeWire = (url: string) =>
      http(url, { retryCount: 0, timeout: pool.attemptTimeoutMs })({ chain });
    const wires = new Map<string, ReturnType<typeof makeWire>>();
    const wireFor = (url: string): ReturnType<typeof makeWire> => {
      let wire = wires.get(url);
      if (!wire) {
        wire = makeWire(url);
        wires.set(url, wire);
      }
      return wire;
    };

    // `signal` is unused: viem's http transport exposes no per-request
    // abort, so the deadline is enforced twice — by viem's own `timeout`
    // (same value) and by the pool's race against the AbortController.
    const rawRequest: RawRequest = async ({ endpoint, method, params }) =>
      wireFor(endpoint.url).request({ method, params });

    return createTransport({
      key: 'resilientRpc',
      name: 'Resilient RPC',
      type: 'resilientRpc',
      // The pool owns retry; the client-level retry stays off so an attempt
      // is never multiplied.
      retryCount: 0,
      timeout: pool.attemptTimeoutMs,
      request: asEip1193RequestFn(async ({ method, params }) =>
        pool.request({ method, params, rawRequest })
      )
    });
  };
};
