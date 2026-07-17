import type { Logger } from '@polygonlabs/logger';

/**
 * The slice of `@polygonlabs/logger`'s `Logger` the pool actually calls.
 * Structural (a `Pick`) so tests and CLI tooling can hand in a minimal
 * implementation without constructing a full pino instance.
 */
export type PoolLogger = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;

/** One JSON-RPC endpoint. Array order in the pool is priority order. */
export interface RpcEndpoint {
  url: string;
}

/** Pool-internal identity of an endpoint, handed to wire closures. */
export interface RpcEndpointHandle {
  readonly index: number;
  readonly url: string;
  /**
   * URL origin only. Logs and error `info` carry the origin, never the full
   * URL — RPC access tokens live in query params.
   */
  readonly origin: string;
}

export type EndpointState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Per-endpoint health, shaped for direct exposure on `/service-status`. */
export interface EndpointSnapshot {
  origin: string;
  state: EndpointState;
  consecutiveFailures: number;
  lastSuccessMs: number | null;
  openSinceMs?: number;
}

export interface SameEndpointBackoffPolicy {
  baseMs: number;
  factor: number;
  maxMs: number;
  jitter: boolean;
}

export interface RequestPolicyOptions {
  /** Hard `AbortController` deadline per attempt. Default `10_000`. */
  attemptTimeoutMs?: number;
  /** Default `endpoints.length + 1`. */
  maxAttempts?: number;
  /**
   * Back-off between consecutive attempts against the SAME endpoint —
   * applied only when no other healthy endpoint exists. Cross-endpoint
   * failover never sleeps. Defaults: `{ baseMs: 250, factor: 2, maxMs:
   * 10_000, jitter: true }`.
   */
  sameEndpointBackoff?: Partial<SameEndpointBackoffPolicy>;
}

export interface ProbePolicyOptions {
  /**
   * Recovery-probe method. Default `'eth_chainId'`; the result must match
   * the pool's `chainId` or the endpoint stays OPEN (catches endpoints that
   * come back serving the wrong chain).
   */
  method?: string;
  /** Default `5_000`. */
  initialDelayMs?: number;
  /** Default `2`. */
  factor?: number;
  /** Default `60_000`. */
  maxDelayMs?: number;
  /** Full jitter on each probe delay. Default `true`. */
  jitter?: boolean;
}

export interface CircuitBreakerOptions {
  /** Consecutive transport failures before the circuit opens. Default `3`. */
  openAfterConsecutiveFailures?: number;
  probe?: ProbePolicyOptions;
}

export interface RawRequestArgs {
  endpoint: RpcEndpointHandle;
  method: string;
  params?: unknown;
  /**
   * Fired when the pool's per-attempt deadline expires. Wires that cannot
   * honour it may ignore it — the pool also races the attempt against the
   * deadline, so the request slot is freed either way.
   */
  signal: AbortSignal;
}

/**
 * A single wire-level JSON-RPC call against one endpoint. Adapters hand the
 * pool one of these so each library keeps its own wire — and its own native
 * error objects, which the pool classifies but never rewraps on the
 * application path. Must resolve with the JSON-RPC `result` and reject with
 * the library's native error.
 */
export type RawRequest = (args: RawRequestArgs) => Promise<unknown>;

/** Structured mirror of the pool's log events, for tests and metrics glue. */
export type RpcPoolEvent =
  | { type: 'endpoint-opened'; chainId: number; endpoint: string; consecutiveFailures: number }
  | { type: 'probe-failed'; chainId: number; endpoint: string; downtimeMs: number }
  | { type: 'endpoint-recovered'; chainId: number; endpoint: string; downtimeMs: number }
  | { type: 'all-endpoints-down'; chainId: number };

export interface CreateRpcPoolOptions {
  chainId: number;
  /** Priority-ordered: endpoint 0 is preferred; the rest are insurance. */
  endpoints: RpcEndpoint[];
  logger: PoolLogger;
  policy?: RequestPolicyOptions;
  circuitBreaker?: CircuitBreakerOptions;
  onEvent?: (event: RpcPoolEvent) => void;
  /**
   * Default wire for `request()` calls and recovery probes. Defaults to the
   * built-in fetch JSON-RPC wire; adapters override per request instead of
   * per pool so probes keep working even when no adapter request is active.
   */
  rawRequest?: RawRequest;
}

export interface RpcRequestArgs {
  method: string;
  params?: unknown;
  /** Adapter wire override for this request (e.g. viem's `http`). */
  rawRequest?: RawRequest;
}

/**
 * One pool per chain per process: create it at the entrypoint and inject it
 * (no module-load work), mirroring the team's logger DI convention.
 */
export interface RpcPool {
  readonly chainId: number;
  readonly endpoints: readonly RpcEndpointHandle[];
  /** Exposed so adapters can align their wire timeouts with the pool's. */
  readonly attemptTimeoutMs: number;
  /** Raw JSON-RPC request through priority routing, failover and breaking. */
  request(args: RpcRequestArgs): Promise<unknown>;
  /** Per-endpoint health snapshot for `/service-status`. */
  snapshot(): EndpointSnapshot[];
  /**
   * Stops recovery-probe timers. They are `unref()`'d anyway, so a batch
   * job exits cleanly even without calling this — `close()` exists for
   * deterministic teardown in long-lived services and tests.
   */
  close(): void;
}
