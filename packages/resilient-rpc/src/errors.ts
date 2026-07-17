import { VError } from '@polygonlabs/verror';

/**
 * Terminal failure of a pool request: every permitted attempt exhausted.
 * `cause` is the last native (per-library) error and `info` carries
 * `{ chainId, attempts, endpoints }`. The pool never logs this itself — it
 * rethrows, and the caller's error boundary logs once.
 */
export class RpcRequestFailedError extends VError {
  override readonly name: string = 'RpcRequestFailedError';
}

/**
 * An endpoint's circuit opened, or a recovery probe failed while it was
 * open. This is the headline degrade alert: monitor
 * `@err.name:RpcEndpointDegradedError` in Datadog.
 */
export class RpcEndpointDegradedError extends VError {
  override readonly name: string = 'RpcEndpointDegradedError';
}

/** Every endpoint's circuit is open; the pool is in last-resort rotation. */
export class RpcAllEndpointsDownError extends VError {
  override readonly name: string = 'RpcAllEndpointsDownError';
}

// ---------------------------------------------------------------------------
// Wire-level errors, thrown by the built-in fetch wire and the recovery
// probe. Plain Error subclasses rather than VError: they play the role of
// the "native" transport errors viem/ethers wires throw, and the classifier
// routes them by their fields.
// ---------------------------------------------------------------------------

/** The pool's per-attempt `AbortController` deadline fired. Transport-class. */
export class RpcAttemptTimeoutError extends Error {
  override readonly name: string = 'RpcAttemptTimeoutError';
  readonly timeoutMs: number;

  constructor({ timeoutMs }: { timeoutMs: number }) {
    super(`RPC attempt exceeded the ${timeoutMs}ms deadline`);
    this.timeoutMs = timeoutMs;
  }
}

/** Non-2xx HTTP response. 5xx/408 are transport-class; 429 is borderline. */
export class RpcHttpStatusError extends Error {
  override readonly name: string = 'RpcHttpStatusError';
  readonly status: number;

  constructor({ status }: { status: number }) {
    super(`RPC endpoint responded with HTTP ${status}`);
    this.status = status;
  }
}

/** The response body was not a JSON-RPC envelope. Transport-class. */
export class RpcMalformedResponseError extends Error {
  override readonly name: string = 'RpcMalformedResponseError';

  constructor({ cause }: { cause?: Error } = {}) {
    super('RPC endpoint returned a malformed JSON-RPC response', cause ? { cause } : undefined);
  }
}

/**
 * The JSON-RPC `error` member of a response, with its numeric `code`
 * preserved so classification can separate node-broken codes
 * (`-32700`/`-32603`, transport-class) from chain-said errors (reverts,
 * `-32601`/`-32602`, application-class — passed through untouched).
 */
export class JsonRpcResponseError extends Error {
  override readonly name: string = 'JsonRpcResponseError';
  readonly code: number;
  readonly data?: unknown;

  constructor({ code, message, data }: { code: number; message: string; data?: unknown }) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/**
 * A recovery probe answered with the wrong chain id — the endpoint is back
 * up but not trustworthy (wrong network behind the URL). Transport-class:
 * the circuit stays open.
 */
export class RpcChainIdMismatchError extends Error {
  override readonly name: string = 'RpcChainIdMismatchError';
  readonly expectedChainId: number;
  readonly actualResult: unknown;

  constructor({
    expectedChainId,
    actualResult
  }: {
    expectedChainId: number;
    actualResult: unknown;
  }) {
    super(`RPC probe returned chain id ${String(actualResult)}, expected ${expectedChainId}`);
    this.expectedChainId = expectedChainId;
    this.actualResult = actualResult;
  }
}
