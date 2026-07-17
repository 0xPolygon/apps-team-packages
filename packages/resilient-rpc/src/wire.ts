import type { RawRequest } from './types.ts';

import { JsonRpcResponseError, RpcHttpStatusError, RpcMalformedResponseError } from './errors.ts';
import { isRecord, toError } from './internal.ts';

let nextRequestId = 1;

/**
 * The built-in wire: a minimal fetch-based JSON-RPC 2.0 client (global
 * `fetch`, zero dependencies). It backs `pool.request()` when no adapter
 * wire is supplied and ALWAYS backs the recovery probes — probes must work
 * even when no adapter request is in flight.
 *
 * Contract (shared with adapter wires): resolve with the JSON-RPC `result`;
 * throw `JsonRpcResponseError` for a well-formed `error` response so the
 * classifier can route it by code.
 */
export const fetchRawRequest: RawRequest = async ({ endpoint, method, params, signal }) => {
  const response = await fetch(endpoint.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRequestId++, method, params: params ?? [] }),
    signal
  });
  if (!response.ok) throw new RpcHttpStatusError({ status: response.status });

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new RpcMalformedResponseError({ cause: toError(err) });
  }
  if (!isRecord(body)) throw new RpcMalformedResponseError();

  const errorMember = body['error'];
  if (errorMember != null) {
    if (!isRecord(errorMember)) throw new RpcMalformedResponseError();
    const code = errorMember['code'];
    if (typeof code !== 'number') throw new RpcMalformedResponseError();
    const message =
      typeof errorMember['message'] === 'string'
        ? errorMember['message']
        : `JSON-RPC error ${code}`;
    throw new JsonRpcResponseError({ code, message, data: errorMember['data'] });
  }
  if (!('result' in body)) throw new RpcMalformedResponseError();
  return body['result'];
};
