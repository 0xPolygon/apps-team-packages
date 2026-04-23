/**
 * Ethers fetch errors — the ones JsonRpcProvider / FallbackProvider /
 * StaticJsonRpcProvider / anything built on the web fetch layer throws when
 * an RPC HTTP request fails — embed the full request URL (including any
 * `?token=<secret>`) in multiple places on the error. Shape differs between
 * ethers versions:
 *
 *   - **v6** nests it at `err.info.requestUrl`; `err.shortMessage` is a safe
 *     summary ("server response 401 Unauthorized", "timeout", etc.);
 *     `err.message` and `err.stack` echo the full URL in their compound text.
 *   - **v5** exposes it at top-level `err.url`; `err.reason` is a safe
 *     summary ("bad response", "missing response", etc.); `err.message` and
 *     `err.stack` echo the full URL the same way.
 *
 * If an RPC call fails anywhere a service uses `logger.debug({ err })` /
 * `logger.error({ err })` / pino-equivalent, the token lands in log output
 * via pino's default err serialiser, which copies `message`, `stack`, and
 * every enumerable property across. That leak is present whether the error
 * reaches a log call via an HTTP request handler, a cron tick, a background
 * consumer, an `unhandledRejection`, or a startup failure — anywhere logs go.
 *
 * Services often wrap the ethers error with a `VError`/`WError` for
 * contextual logging ("Failed to fetch block number: <cause>"). The
 * sanitiser walks the `.cause` chain so the detection fires whether the
 * ethers error is the outermost throw or nested one or more levels deep,
 * and the full wrapping chain is preserved in the sanitised clone so
 * operators still see what the service was attempting.
 *
 * Detection is deliberately structural rather than `instanceof`-based, so
 * this package does not depend on ethers. Extend the detectors below when
 * adopting a new RPC library with a similar fingerprint.
 */

/** Reduce any URLs found in a string to their origin (protocol + host). */
function stripUrlsInPlace(text: string): string {
  return text.replace(/https?:\/\/[^\s"',)]+/g, (url) => {
    try {
      return new URL(url).origin;
    } catch {
      return '[redacted]';
    }
  });
}

function tryOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '[redacted]';
  }
}

interface Detected {
  /** Fully sanitised `info` object to attach to the log-clone error node. */
  info: Record<string, unknown>;
  /** Code field to propagate from the ethers error onto the log clone node. */
  code: string | undefined;
}

type ErrorLike = Error & Record<string, unknown>;

/**
 * Ethers v6 fingerprint: `err.info` is an object containing `requestUrl`.
 * Preserves all other info fields (e.g. `responseStatus`, `responseBody`) so
 * operators keep useful debug context; only `requestUrl` is rewritten to
 * its origin.
 */
function detectV6(err: ErrorLike): Detected | null {
  const info = err.info;
  if (!info || typeof info !== 'object' || !('requestUrl' in info)) return null;

  const source = info as Record<string, unknown>;
  const safe: Record<string, unknown> = { ...source };
  if (typeof safe.requestUrl === 'string') {
    safe.requestUrl = tryOrigin(safe.requestUrl);
  }

  return {
    info: safe,
    code: typeof err.code === 'string' ? err.code : undefined
  };
}

/**
 * Ethers v5 fingerprint: top-level string `err.url` alongside an error code
 * that the v5 web layer raises for RPC HTTP failures. Unlike v6, v5 attaches
 * every `Logger.throwError` param — `url`, `body`, `responseText`,
 * `serverError`, etc. — as top-level properties on the error, so the log
 * clone builds a fresh `info` with only the sanitised URL (and the response
 * status, when present) instead of copying through potentially-leaky fields.
 */
const V5_CODES = new Set(['SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR']);

function detectV5(err: ErrorLike): Detected | null {
  const code = typeof err.code === 'string' ? err.code : null;
  const url = typeof err.url === 'string' ? err.url : null;
  if (!code || !url || !V5_CODES.has(code)) return null;

  const info: Record<string, unknown> = { requestUrl: tryOrigin(url) };
  if (typeof err.status === 'number') info.responseStatus = err.status;

  return { info, code };
}

/**
 * Walk an error's native `.cause` chain into a flat, cycle-safe array. Both
 * `VError` and native `new Error(msg, { cause })` expose the link as
 * `err.cause`, so this covers both.
 */
function walkCauseChain(err: Error): Error[] {
  const chain: Error[] = [];
  const visited = new Set<Error>();
  let current: Error | null = err;
  while (current && !visited.has(current)) {
    visited.add(current);
    chain.push(current);
    const nextCause: unknown = (current as { cause?: unknown }).cause;
    current = nextCause instanceof Error ? nextCause : null;
  }
  return chain;
}

/**
 * Produce a log-safe clone of a single error node. Called once per chain
 * node during sanitisation:
 *
 *   - `message` and `stack` are always URL-stripped. Defence in depth: a
 *     wrapping `VError` may have folded its cause's compound message, and
 *     any node could carry a URL in its text for reasons we don't control.
 *   - If this node is the detected ethers fetch error, its `info` is rebuilt
 *     from the detector's output (`{ requestUrl: origin, responseStatus? }`).
 *     For v5 that means dropping the top-level `body`, `responseText`,
 *     `url`, etc.; for v6 that means dropping any other `info` fields
 *     alongside `requestUrl`.
 *   - If it is not the ethers node but carries a generic `info` (typical
 *     VError), that info is preserved as-is. We do not deep-scrub VError
 *     info values: callers own that namespace, and collateral URL-stripping
 *     could mangle intentional data.
 *   - `code` is propagated if present.
 */
function sanitiseNode(e: Error, detected: Detected | null): Error {
  const clone = new Error(stripUrlsInPlace(e.message));
  clone.name = e.name;
  if (e.stack) clone.stack = stripUrlsInPlace(e.stack);

  const source = e as ErrorLike;
  const code = detected?.code ?? (typeof source.code === 'string' ? source.code : undefined);
  if (code !== undefined) (clone as ErrorLike).code = code;

  if (detected) {
    (clone as ErrorLike).info = detected.info;
  } else if (source.info && typeof source.info === 'object') {
    (clone as ErrorLike).info = source.info;
  }
  return clone;
}

/**
 * If `err` — or any error in its `.cause` chain — looks like an ethers v5 or
 * v6 fetch error, returns a sanitised clone of the error: the full cause
 * chain is preserved node-for-node with every `message` and `stack`
 * URL-stripped, the ethers node's `info` reduced to
 * `{ requestUrl: origin, ... }`, and intermediate `VError`/`WError` wrappers
 * kept intact with their own `info` and stack traces. Returns `null` for
 * any other error shape, letting the caller fall through to default
 * handling.
 *
 * Preserving the chain matters: a service that wraps an ethers failure with
 * `new VError('failed to fetch block number', { cause: ethersErr })` logs a
 * full picture of "what was being attempted" and "why the RPC refused it".
 * Flattening the chain to a single ethers-only clone throws away the first
 * half — which is exactly the half operators reach for when debugging.
 *
 * The returned error is the only product: callers decide how to use it.
 * This module is deliberately unaware of whether its output is destined for
 * a log, an HTTP response body, a Sentry event, or something else.
 * `@polygonlabs/logger`'s pino `err` serializer passes the sanitised clone
 * through for log output; `@polygonlabs/express`'s global error handler
 * uses the same sanitised clone's `.message` for HTTP response bodies.
 * Both consumers use the function identically — the sanitiser has no
 * awareness of "log vs response" shapes.
 */
export function sanitiseEthersFetchError(err: unknown): Error | null {
  if (!(err instanceof Error)) return null;

  const chain = walkCauseChain(err);
  // Detect per-node so the rebuild applies only to the ethers node, leaving
  // any intermediate wrappers' info fields intact.
  const detections = chain.map(
    (node) => detectV6(node as ErrorLike) ?? detectV5(node as ErrorLike)
  );
  const hit = detections.some((d) => d !== null);
  if (!hit) return null;

  const clones = chain.map((node, i) => sanitiseNode(node, detections[i] ?? null));
  for (let i = 0; i < clones.length - 1; i++) {
    const link = clones[i];
    const next = clones[i + 1];
    if (link && next) (link as ErrorLike).cause = next;
  }

  return clones[0] ?? null;
}
