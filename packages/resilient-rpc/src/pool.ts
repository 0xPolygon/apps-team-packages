import { VError } from '@polygonlabs/verror';

import type {
  CreateRpcPoolOptions,
  EndpointSnapshot,
  EndpointState,
  RawRequest,
  RpcEndpointHandle,
  RpcPool,
  RpcPoolEvent,
  RpcRequestArgs,
  SameEndpointBackoffPolicy
} from './types.ts';

import { classifyRpcError } from './classify.ts';
import {
  RpcAllEndpointsDownError,
  RpcAttemptTimeoutError,
  RpcChainIdMismatchError,
  RpcEndpointDegradedError,
  RpcRequestFailedError
} from './errors.ts';
import { toError } from './internal.ts';
import { fetchRawRequest } from './wire.ts';

interface EndpointRuntime {
  readonly handle: RpcEndpointHandle;
  state: EndpointState;
  consecutiveFailures: number;
  lastSuccessMs: number | null;
  openSinceMs: number | undefined;
  probeAttempt: number;
  probeTimer: NodeJS.Timeout | undefined;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Rejects with the abort reason the moment `signal` fires. */
const rejectOnAbort = (signal: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(signal.reason instanceof Error ? signal.reason : toError(signal.reason));
      },
      { once: true }
    );
  });

/** Full jitter (AWS-style): a uniform draw decorrelates synchronized retries. */
const jitteredDelay = ({ delayMs, jitter }: { delayMs: number; jitter: boolean }): number =>
  jitter ? Math.random() * delayMs : delayMs;

const backoffDelayMs = (policy: SameEndpointBackoffPolicy, step: number): number =>
  jitteredDelay({
    delayMs: Math.min(policy.maxMs, policy.baseMs * policy.factor ** step),
    jitter: policy.jitter
  });

/** `eth_chainId` returns a hex quantity; probes tolerate number/bigint too. */
const chainIdFromResult = (result: unknown): number | undefined => {
  if (typeof result === 'number' && Number.isInteger(result)) return result;
  if (typeof result === 'bigint') return Number(result);
  if (typeof result === 'string' && /^0x[0-9a-fA-F]+$/.test(result)) {
    return Number.parseInt(result, 16);
  }
  return undefined;
};

/**
 * Creates a resilient multi-endpoint JSON-RPC pool: priority routing across
 * `endpoints` (array order = priority), zero-sleep failover on
 * transport-class failures, a per-endpoint circuit breaker
 * (CLOSED → OPEN → HALF_OPEN) with background `eth_chainId` recovery probes,
 * and log-driven degrade signalling via named VError subclasses.
 *
 * One pool per chain per process — create at the entrypoint and inject.
 */
export const createRpcPool = (options: CreateRpcPoolOptions): RpcPool => {
  const { chainId, logger, onEvent } = options;
  if (options.endpoints.length === 0) {
    throw new VError('createRpcPool requires at least one endpoint', { info: { chainId } });
  }

  const policy = {
    attemptTimeoutMs: options.policy?.attemptTimeoutMs ?? 10_000,
    maxAttempts: options.policy?.maxAttempts ?? options.endpoints.length + 1,
    sameEndpointBackoff: {
      baseMs: 250,
      factor: 2,
      maxMs: 10_000,
      jitter: true,
      ...options.policy?.sameEndpointBackoff
    }
  };
  const breaker = {
    openAfterConsecutiveFailures: options.circuitBreaker?.openAfterConsecutiveFailures ?? 3,
    probe: {
      method: 'eth_chainId',
      initialDelayMs: 5_000,
      factor: 2,
      maxDelayMs: 60_000,
      jitter: true,
      ...options.circuitBreaker?.probe
    }
  };
  const defaultWire = options.rawRequest ?? fetchRawRequest;

  const endpoints: EndpointRuntime[] = options.endpoints.map((endpoint, index) => {
    let origin: string;
    try {
      origin = new URL(endpoint.url).origin;
    } catch (err) {
      throw new VError(`invalid RPC endpoint URL at index ${index}`, {
        cause: toError(err),
        info: { chainId, index }
      });
    }
    return {
      handle: { index, url: endpoint.url, origin },
      state: 'CLOSED',
      consecutiveFailures: 0,
      lastSuccessMs: null,
      openSinceMs: undefined,
      probeAttempt: 0,
      probeTimer: undefined
    };
  });

  let poolClosed = false;

  const emit = (event: RpcPoolEvent): void => {
    onEvent?.(event);
  };

  const healthyCount = (): number => endpoints.filter((e) => e.state === 'CLOSED').length;

  const degradedInfo = (ep: EndpointRuntime): Record<string, unknown> => ({
    endpoint: ep.handle.origin,
    chainId,
    consecutiveFailures: ep.consecutiveFailures,
    healthyEndpoints: healthyCount(),
    totalEndpoints: endpoints.length
  });

  const scheduleProbe = (ep: EndpointRuntime): void => {
    if (poolClosed) return;
    const delay = jitteredDelay({
      delayMs: Math.min(
        breaker.probe.maxDelayMs,
        breaker.probe.initialDelayMs * breaker.probe.factor ** ep.probeAttempt
      ),
      jitter: breaker.probe.jitter
    });
    const timer = setTimeout(() => {
      void runProbe(ep);
    }, delay);
    // unref so an open circuit never keeps a finished batch job alive.
    timer.unref();
    ep.probeTimer = timer;
  };

  const openEndpoint = (ep: EndpointRuntime, cause: Error): void => {
    ep.state = 'OPEN';
    ep.openSinceMs = Date.now();
    ep.probeAttempt = 0;
    const err = new RpcEndpointDegradedError(
      `RPC endpoint ${ep.handle.origin} degraded on chain ${chainId}: circuit opened after ${ep.consecutiveFailures} consecutive transport failures`,
      { cause, info: degradedInfo(ep) }
    );
    logger.error({ err, chainId }, 'RPC endpoint circuit opened');
    emit({
      type: 'endpoint-opened',
      chainId,
      endpoint: ep.handle.origin,
      consecutiveFailures: ep.consecutiveFailures
    });
    scheduleProbe(ep);
  };

  const closeEndpoint = (ep: EndpointRuntime): void => {
    const downtimeMs = Date.now() - (ep.openSinceMs ?? Date.now());
    if (ep.probeTimer) clearTimeout(ep.probeTimer);
    ep.probeTimer = undefined;
    ep.state = 'CLOSED';
    ep.consecutiveFailures = 0;
    ep.lastSuccessMs = Date.now();
    ep.openSinceMs = undefined;
    ep.probeAttempt = 0;
    logger.info({ chainId, endpoint: ep.handle.origin, downtimeMs }, 'RPC endpoint recovered');
    emit({ type: 'endpoint-recovered', chainId, endpoint: ep.handle.origin, downtimeMs });
  };

  const recordSuccess = (ep: EndpointRuntime): void => {
    if (ep.state === 'OPEN') {
      // A real request succeeded during last-resort rotation — stronger
      // evidence than a probe; close the circuit directly.
      closeEndpoint(ep);
      return;
    }
    ep.consecutiveFailures = 0;
    ep.lastSuccessMs = Date.now();
  };

  const recordFailure = (ep: EndpointRuntime, cause: Error): void => {
    ep.consecutiveFailures += 1;
    if (ep.state === 'CLOSED' && ep.consecutiveFailures >= breaker.openAfterConsecutiveFailures) {
      openEndpoint(ep, cause);
    }
  };

  const attemptOnce = async ({
    ep,
    method,
    params,
    rawRequest
  }: {
    ep: EndpointRuntime;
    method: string;
    params: unknown;
    rawRequest: RawRequest;
  }): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new RpcAttemptTimeoutError({ timeoutMs: policy.attemptTimeoutMs }));
    }, policy.attemptTimeoutMs);
    try {
      const wirePromise = Promise.resolve(
        rawRequest({ endpoint: ep.handle, method, params, signal: controller.signal })
      );
      // A wire that ignores `signal` may reject after the race is already
      // lost; keep that from surfacing as an unhandled rejection.
      wirePromise.catch(() => undefined);
      return await Promise.race([wirePromise, rejectOnAbort(controller.signal)]);
    } finally {
      clearTimeout(timer);
    }
  };

  const runProbe = async (ep: EndpointRuntime): Promise<void> => {
    if (poolClosed || ep.state !== 'OPEN') return;
    // Exactly one in-flight probe per endpoint; requests never route here.
    ep.state = 'HALF_OPEN';
    try {
      const result = await attemptOnce({
        ep,
        method: breaker.probe.method,
        params: [],
        rawRequest: defaultWire
      });
      const actual = chainIdFromResult(result);
      if (actual !== chainId) {
        throw new RpcChainIdMismatchError({ expectedChainId: chainId, actualResult: result });
      }
      closeEndpoint(ep);
    } catch (rawError) {
      ep.state = 'OPEN';
      ep.probeAttempt += 1;
      ep.consecutiveFailures += 1;
      const downtimeMs = Date.now() - (ep.openSinceMs ?? Date.now());
      const err = new RpcEndpointDegradedError(
        `RPC endpoint ${ep.handle.origin} on chain ${chainId} still failing after ${downtimeMs}ms open`,
        { cause: toError(rawError), info: { ...degradedInfo(ep), downtimeMs } }
      );
      logger.error({ err, chainId }, 'RPC endpoint re-probe failed; circuit stays open');
      emit({ type: 'probe-failed', chainId, endpoint: ep.handle.origin, downtimeMs });
      scheduleProbe(ep);
    }
  };

  const request = async ({
    method,
    params,
    rawRequest = defaultWire
  }: RpcRequestArgs): Promise<unknown> => {
    if (poolClosed) {
      throw new RpcRequestFailedError(`RPC pool for chain ${chainId} is closed`, {
        info: { chainId, attempts: 0, endpoints: [] }
      });
    }
    // Write safety: `eth_sendRawTransaction` is failover-safe — idempotent
    // by tx hash, and an "already known" rejection on a retried endpoint
    // means an earlier attempt landed (it passes through application-class;
    // callers should treat it as success).
    // TODO: translate "already known" into the tx hash locally (needs
    // keccak over the raw tx — deliberately out of scope for v1 to keep the
    // core dependency-free).
    // `eth_sendTransaction` is NOT failover-safe (the node assigns the
    // nonce, so a retry can double-send): single attempt, no failover.
    const maxAttempts = method === 'eth_sendTransaction' ? 1 : policy.maxAttempts;

    const attemptedEndpoints: string[] = [];
    let lastError: Error | undefined;
    let previous: EndpointRuntime | undefined;
    let sameEndpointStreak = 0;
    let allDownEmitted = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Re-evaluate candidates each attempt: circuits open and close
      // underneath a long request.
      let candidates = endpoints.filter((e) => e.state === 'CLOSED');
      if (candidates.length === 0) {
        // Last resort: every circuit is open — try them anyway in priority
        // order (an answer from a degraded endpoint beats no answer). Never
        // route to HALF_OPEN: it carries exactly one in-flight probe.
        candidates = endpoints.filter((e) => e.state !== 'HALF_OPEN');
        if (!allDownEmitted) {
          allDownEmitted = true;
          const err = new RpcAllEndpointsDownError(
            `all ${endpoints.length} RPC endpoints for chain ${chainId} have open circuits`,
            { info: { chainId, totalEndpoints: endpoints.length } }
          );
          logger.error({ err, chainId }, 'All RPC endpoints down; entering last-resort rotation');
          emit({ type: 'all-endpoints-down', chainId });
        }
        if (candidates.length === 0) break; // everything HALF_OPEN; probes in flight
      }
      const ep = candidates[attempt % candidates.length];
      if (ep === undefined) break; // unreachable; satisfies indexed access

      if (ep === previous) {
        // Re-hitting the endpoint we just failed on — nothing else is
        // healthy, so back off. Cross-endpoint failover never sleeps.
        sameEndpointStreak += 1;
        await sleep(backoffDelayMs(policy.sameEndpointBackoff, sameEndpointStreak - 1));
      } else {
        sameEndpointStreak = 0;
      }

      try {
        const result = await attemptOnce({ ep, method, params, rawRequest });
        recordSuccess(ep);
        return result;
      } catch (rawError) {
        const errorClass = classifyRpcError(rawError);
        if (errorClass === 'application') {
          // The chain said no: pass the native error through untouched.
          throw rawError;
        }
        const err = toError(rawError);
        lastError = err;
        attemptedEndpoints.push(ep.handle.origin);
        if (errorClass === 'transport') recordFailure(ep, err);
        previous = ep;
        if (attempt + 1 < maxAttempts) {
          logger.warn(
            { err, chainId, endpoint: ep.handle.origin, attempt: attempt + 1, maxAttempts },
            'RPC attempt failed; failing over'
          );
        }
      }
    }

    // Terminal: rethrow only — the caller's boundary logs once.
    throw new RpcRequestFailedError(
      `RPC request ${method} exhausted ${attemptedEndpoints.length} attempt(s) on chain ${chainId}`,
      {
        ...(lastError ? { cause: lastError } : {}),
        info: { chainId, attempts: attemptedEndpoints.length, endpoints: attemptedEndpoints }
      }
    );
  };

  const snapshot = (): EndpointSnapshot[] =>
    endpoints.map((ep) => ({
      origin: ep.handle.origin,
      state: ep.state,
      consecutiveFailures: ep.consecutiveFailures,
      lastSuccessMs: ep.lastSuccessMs,
      ...(ep.openSinceMs === undefined ? {} : { openSinceMs: ep.openSinceMs })
    }));

  const close = (): void => {
    poolClosed = true;
    for (const ep of endpoints) {
      if (ep.probeTimer) clearTimeout(ep.probeTimer);
      ep.probeTimer = undefined;
    }
  };

  return {
    chainId,
    endpoints: endpoints.map((ep) => ep.handle),
    attemptTimeoutMs: policy.attemptTimeoutMs,
    request,
    snapshot,
    close
  };
};
