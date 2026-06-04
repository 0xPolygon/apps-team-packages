/**
 * RPC fetch errors — the ones a JSON-RPC client throws when an HTTP
 * request to a node fails — embed the full request URL (including any
 * `?token=<secret>`) in multiple places on the error. Shape differs by
 * library:
 *
 *   - **ethers v6** nests it at `err.info.requestUrl`; `err.shortMessage`
 *     is a safe summary ("server response 401 Unauthorized", "timeout",
 *     etc.); `err.message` and `err.stack` echo the full URL in their
 *     compound text.
 *   - **ethers v5** exposes it at top-level `err.url`; `err.reason` is a
 *     safe summary ("bad response", "missing response", etc.);
 *     `err.message` and `err.stack` echo the full URL the same way.
 *   - **viem** carries it only inside its multi-line compound `message`
 *     (and `metaMessages`) — `RpcRequestError` and `HttpRequestError`
 *     are the two URL-bearing classes. Every wrapping viem error
 *     (`ContractFunctionExecutionError`, `EstimateGasExecutionError`,
 *     etc.) echoes the URL too because viem builds each parent's
 *     `message` from the child's compound text.
 *
 * If an RPC call fails anywhere a service serialises the error to log
 * output, persisted state (Firestore, status routes), Sentry events, or
 * HTTP response bodies, the token lands wherever that data lands. The
 * leak is independent of which path the error reached: HTTP request
 * handler, cron tick, background consumer, `unhandledRejection`,
 * startup failure — anywhere errors go.
 *
 * Services often wrap the RPC error with a `VError`/`WError` for
 * contextual context ("Failed to fetch block number: <cause>"). The
 * sanitiser walks the `.cause` chain so the detection fires whether the
 * RPC error is the outermost throw or nested one or more levels deep,
 * and the full wrapping chain is preserved in the sanitised clone so
 * operators still see what the service was attempting.
 *
 * Lives in `@polygonlabs/verror` rather than `@polygonlabs/logger`
 * because it is an Error primitive — peer with `cause()`, `info()`,
 * `fullStack()` — not a logging concern. Logger was historically the
 * first consumer and remains a consumer (re-exporting for the existing
 * import path), but `serializeError` and `VError.toJSON` now invoke it
 * automatically so any persistence path (not just logs) gets URL
 * stripping by default.
 *
 * Detection is deliberately structural rather than `instanceof`-based, so
 * this package does not depend on ethers or viem. Extend the detectors
 * below when adopting a new RPC library with a similar fingerprint.
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
  /** Fully sanitised `info` object to attach to the sanitised clone node. */
  info: Record<string, unknown>;
  /** Code field to propagate from the RPC error onto the sanitised clone node. */
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
 * `serverError`, etc. — as top-level properties on the error, so the
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
 * viem fingerprint: `RpcRequestError` (JSON-RPC layer) and
 * `HttpRequestError` (transport layer) carry the full URL in their
 * multi-line `message` and the `metaMessages` array that viem's
 * `BaseError` builds. Neither class exposes the URL as a discrete field,
 * so the sanitised clone's `info` is intentionally empty — detection
 * here is enough, since the chain rebuild runs `stripUrlsInPlace` on
 * every node's `message` and `stack` once any node matches.
 *
 * `metaMessages` being an array is a viem `BaseError`-specific marker;
 * it makes the fingerprint specific enough that an unrelated library
 * happening to share the class name won't falsely match. viem error
 * codes are JSON-RPC numeric codes — they're useful to operators but
 * the existing `Detected.code` carries string codes only, so we don't
 * propagate them onto the clone; the human description in `message`
 * preserves the context.
 */
function detectViem(err: ErrorLike): Detected | null {
  if (err.name !== 'RpcRequestError' && err.name !== 'HttpRequestError') return null;
  if (!Array.isArray(err.metaMessages)) return null;
  return { info: {}, code: undefined };
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
 * Produce a safe clone of a single error node. Called once per chain
 * node during sanitisation:
 *
 *   - `message` and `stack` are always URL-stripped. Defence in depth: a
 *     wrapping `VError` may have folded its cause's compound message, and
 *     any node could carry a URL in its text for reasons we don't control.
 *   - `shortMessage` is preserved (URL-stripped) so downstream serialisation
 *     — `serializeError`'s plain-Error branch and any consumer reading
 *     `err.shortMessage` directly — keeps the cleaner summary text rather
 *     than collapsing to the full compound `message`.
 *   - If this node is the detected RPC fetch error, its `info` is rebuilt
 *     from the detector's output (`{ requestUrl: origin, responseStatus? }`
 *     for ethers; `{}` for viem, which doesn't expose the URL as a discrete
 *     field). For v5 that means dropping the top-level `body`,
 *     `responseText`, `url`, etc.; for v6 that means dropping any other
 *     `info` fields alongside `requestUrl`.
 *   - If it is not the RPC node but carries a generic `info` (typical
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
  const sourceShortMessage = (source as { shortMessage?: unknown }).shortMessage;
  if (typeof sourceShortMessage === 'string') {
    (clone as ErrorLike).shortMessage = stripUrlsInPlace(sourceShortMessage);
  }

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
 * If `err` — or any error in its `.cause` chain — looks like an ethers v5,
 * ethers v6, or viem RPC fetch error, returns a sanitised clone of the
 * error: the full cause chain is preserved node-for-node with every
 * `message` and `stack` URL-stripped, the detected node's `info` reduced
 * to the structured-URL form the library exposes (`{ requestUrl: origin,
 * ... }` for ethers; empty `{}` for viem, which doesn't expose the URL as
 * a discrete field), and intermediate `VError`/`WError` wrappers kept
 * intact with their own `info` and stack traces. Returns `null` for any
 * other error shape, letting the caller fall through to default handling.
 *
 * Preserving the chain matters: a service that wraps an RPC failure with
 * `new VError('failed to fetch block number', { cause: rpcErr })` logs a
 * full picture of "what was being attempted" and "why the RPC refused it".
 * Flattening the chain to a single RPC-only clone throws away the first
 * half — which is exactly the half operators reach for when debugging.
 *
 * @internal
 *
 * Prefer `serializeError` / `VError.toJSON` for any serialisation path —
 * they call this function at their entry, so logs, status routes, Sentry
 * events, Firestore documents, and `JSON.stringify(err)` are all safe by
 * default without the caller knowing this function exists. This export
 * is a building block for the narrow set of pipelines that need an
 * `Error`-in/`Error`-out sanitiser rather than a serialised `Record`:
 * the canonical example is `@polygonlabs/logger`'s pino `err` serializer,
 * which feeds the sanitised clone into pino's `stdSerializers.err` to
 * inherit pino's standard error shape. Adding a new direct call site is
 * a signal to review whether `serializeError` would do — almost always
 * the answer is yes.
 */
export function sanitiseRpcFetchError(err: unknown): Error | null {
  if (!(err instanceof Error)) return null;

  const chain = walkCauseChain(err);
  // Detect per-node so the rebuild applies only to the RPC node, leaving
  // any intermediate wrappers' info fields intact.
  const detections = chain.map(
    (node) =>
      detectV6(node as ErrorLike) ?? detectV5(node as ErrorLike) ?? detectViem(node as ErrorLike)
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
