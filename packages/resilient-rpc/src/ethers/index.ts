import type {
  JsonRpcApiProviderOptions,
  JsonRpcError,
  JsonRpcPayload,
  JsonRpcResult
} from 'ethers';

import { JsonRpcApiProvider, Network } from 'ethers';

import type { RpcPool } from '../types.ts';

import { JsonRpcResponseError } from '../errors.ts';

/**
 * An ethers v6 provider backed by a resilient RPC pool.
 *
 * Extends `JsonRpcApiProvider` and overrides `_send`, so every request —
 * including ethers' internal ones — routes through the pool's priority
 * routing, failover and circuit breaker. The network is pinned statically
 * from `pool.chainId` (`staticNetwork`): no chain-id round-trips, no cached
 * chain state, safe as a long-lived singleton.
 *
 * JSON-RPC error responses the pool passes through (application-class:
 * reverts, bad params, nonce errors) are handed back to ethers as JSON-RPC
 * `error` payloads so ethers applies its native mapping (`CALL_EXCEPTION`,
 * …). Transport exhaustion (`RpcRequestFailedError`) propagates as a throw.
 *
 * TODO (deferred from v1): reuse ethers' own `FetchRequest` wire per
 * endpoint (custom headers, ethers-native transport errors) instead of the
 * pool's built-in fetch wire; an ethers v5 adapter; the filter-id
 * subscriber optimisation (`JsonRpcApiPollingProvider` is not part of
 * ethers' public export surface — event listeners fall back to
 * `AbstractProvider`'s polling subscribers, which work fine).
 */
export class ResilientJsonRpcProvider extends JsonRpcApiProvider {
  readonly #pool: RpcPool;

  constructor(pool: RpcPool, options?: JsonRpcApiProviderOptions) {
    const network = Network.from(pool.chainId);
    super(network, { ...options, staticNetwork: network });
    this.#pool = pool;
  }

  override async send(
    method: string,
    params: unknown[] | Record<string, unknown>
  ): Promise<unknown> {
    // Mirrors ethers' own JsonRpcProvider.send: defer `_start()` to the
    // first real request so constructing the provider does no network work.
    await this._start();
    return super.send(method, params);
  }

  override async _send(
    payload: JsonRpcPayload | JsonRpcPayload[]
  ): Promise<(JsonRpcResult | JsonRpcError)[]> {
    const payloads = Array.isArray(payload) ? payload : [payload];
    return Promise.all(payloads.map(async (single) => this.#sendOne(single)));
  }

  async #sendOne(payload: JsonRpcPayload): Promise<JsonRpcResult | JsonRpcError> {
    try {
      const result = await this.#pool.request({ method: payload.method, params: payload.params });
      return { id: payload.id, result };
    } catch (err) {
      // A well-formed JSON-RPC error response from the wire: hand it back
      // as a JSON-RPC error payload so ethers applies its native mapping.
      if (err instanceof JsonRpcResponseError) {
        return { id: payload.id, error: { code: err.code, message: err.message, data: err.data } };
      }
      throw err;
    }
  }
}
