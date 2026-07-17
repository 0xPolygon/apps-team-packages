import {
  RpcAttemptTimeoutError,
  RpcChainIdMismatchError,
  RpcHttpStatusError,
  RpcMalformedResponseError
} from './errors.ts';
import { isRecord } from './internal.ts';

/**
 * How a failed attempt affects routing and endpoint health.
 *
 * - `transport` — the ENDPOINT is impugned: fail over to the next healthy
 *   endpoint immediately and count the failure toward opening this
 *   endpoint's circuit.
 * - `borderline` — retriable elsewhere but not evidence the endpoint is
 *   down (rate limiting, endpoint-local data availability): fail over
 *   WITHOUT counting toward opening.
 * - `application` — the CHAIN said no (revert, bad params, nonce/funds…):
 *   thrown to the caller immediately, native error untouched; no retry, no
 *   failover, no health impact. Unknown errors default here so novel error
 *   shapes never poison endpoint health.
 */
export type RpcErrorClass = 'transport' | 'borderline' | 'application';

// Node/undici system-level failure codes (DNS, connect, reset, timeouts).
const TRANSPORT_SYSTEM_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNABORTED',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'ABORT_ERR'
]);

// TLS / certificate failures (Node error code prefixes).
const TRANSPORT_TLS_CODE_PATTERN = /^(ERR_TLS_|ERR_SSL_|UNABLE_TO_|CERT_|SELF_SIGNED_|DEPTH_ZERO_)/;

// ethers v6 `error.code` values.
const ETHERS_TRANSPORT_CODES = new Set(['SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR']);
const ETHERS_APPLICATION_CODES = new Set([
  'CALL_EXCEPTION',
  'INSUFFICIENT_FUNDS',
  'NONCE_EXPIRED',
  'REPLACEMENT_UNDERPRICED',
  'TRANSACTION_REPLACED',
  'ACTION_REJECTED',
  'INVALID_ARGUMENT',
  'MISSING_ARGUMENT',
  'UNEXPECTED_ARGUMENT',
  'UNSUPPORTED_OPERATION'
]);

// JSON-RPC numeric codes.
const JSONRPC_TRANSPORT_CODES = new Set([-32700, -32603]); // parse error, internal error
// 3 = execution revert; -32601/-32602 = method not found / invalid params;
// 4001/5000 = user rejected (EIP-1193 / CAIP-25).
const JSONRPC_APPLICATION_CODES = new Set([3, -32601, -32602, 4001, 5000]);
const JSONRPC_BORDERLINE_CODES = new Set([-32005]); // limit exceeded (rate limiting)

// Execution-revert detection floor — viem's `ExecutionRevertedError` node
// message pattern, widened to the common node phrasings ("reverted",
// "revert reason", …).
const REVERT_MESSAGE_PATTERN = /execution reverted|revert(ed)?\b/i;

// Chain-said failures that arrive as bare `-32000`-style messages.
const APPLICATION_MESSAGE_PATTERN =
  /nonce too low|nonce too high|invalid nonce|insufficient funds|transaction underpriced|replacement transaction underpriced|already known|known transaction|max fee per gas less than block base fee/i;

// Endpoint-local data availability and rate limiting: retriable elsewhere,
// but not evidence the endpoint is down.
const BORDERLINE_MESSAGE_PATTERN =
  /header not found|block not found|missing trie node|pruned|state (is )?not available|older than the earliest|too many requests|rate limit/i;

// viem error names whose presence alone marks the attempt transport-class.
// (`RpcRequestError` is deliberately absent — it carries a numeric JSON-RPC
// `code` and is classified by that code instead.)
const VIEM_TRANSPORT_NAMES = new Set(['HttpRequestError', 'TimeoutError', 'WebSocketRequestError']);

const classifyHttpStatus = (status: number): RpcErrorClass | undefined => {
  if (status === 429) return 'borderline';
  if (status === 408 || status >= 500) return 'transport';
  return undefined;
};

const classifyNode = (node: unknown): RpcErrorClass | undefined => {
  if (
    node instanceof RpcAttemptTimeoutError ||
    node instanceof RpcMalformedResponseError ||
    node instanceof RpcChainIdMismatchError
  ) {
    return 'transport';
  }
  if (node instanceof RpcHttpStatusError) {
    // The request never reached the chain, so application-class is
    // meaningless here; statuses outside the 5xx/408 transport set (401,
    // 403, …) fail over without impugning endpoint health — a bad key on
    // one endpoint doesn't mean the endpoint is down.
    return classifyHttpStatus(node.status) ?? 'borderline';
  }
  if (!isRecord(node)) return undefined;

  const code = node['code'];
  const status = node['status'];
  const message = typeof node['message'] === 'string' ? node['message'] : '';
  const name = typeof node['name'] === 'string' ? node['name'] : '';

  if (typeof code === 'number') {
    if (JSONRPC_APPLICATION_CODES.has(code)) return 'application';
    if (JSONRPC_TRANSPORT_CODES.has(code)) return 'transport';
    if (JSONRPC_BORDERLINE_CODES.has(code)) return 'borderline';
  }
  if (REVERT_MESSAGE_PATTERN.test(message) || APPLICATION_MESSAGE_PATTERN.test(message)) {
    return 'application';
  }
  if (BORDERLINE_MESSAGE_PATTERN.test(message)) return 'borderline';
  if (typeof code === 'string') {
    if (ETHERS_APPLICATION_CODES.has(code)) return 'application';
    if (
      TRANSPORT_SYSTEM_CODES.has(code) ||
      ETHERS_TRANSPORT_CODES.has(code) ||
      TRANSPORT_TLS_CODE_PATTERN.test(code)
    ) {
      return 'transport';
    }
  }
  if (typeof status === 'number') {
    const byStatus = classifyHttpStatus(status);
    if (byStatus) return byStatus;
  }
  if (VIEM_TRANSPORT_NAMES.has(name) || name === 'AbortError') return 'transport';
  return undefined;
};

/**
 * Classifies a failed attempt's error, walking the `cause` chain (bounded)
 * until a node yields a decisive class. Only endpoint-impugning failures may
 * touch endpoint health; anything unrecognised defaults to
 * application-class and passes through to the caller untouched.
 */
export const classifyRpcError = (err: unknown): RpcErrorClass => {
  let node: unknown = err;
  for (let depth = 0; depth < 10 && node != null; depth++) {
    const errorClass = classifyNode(node);
    if (errorClass) return errorClass;
    node = isRecord(node) ? node['cause'] : undefined;
  }
  return 'application';
};
