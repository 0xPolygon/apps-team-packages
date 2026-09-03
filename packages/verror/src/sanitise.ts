/**
 * RPC fetch errors — the ones a JSON-RPC client throws when an HTTP
 * request to a node fails — embed the full request URL (including any
 * `?token=<secret>`, and for some gateways a key in the URL *path*) in
 * multiple places on the error. Shape differs by library:
 *
 *   - **ethers v6** nests it at `err.info.requestUrl` and on the
 *     top-level `err.request`/`err.response` pair; `err.shortMessage`
 *     is a safe summary ("server response 401 Unauthorized", "timeout",
 *     etc.); `err.message` and `err.stack` echo the full URL in their
 *     compound text.
 *   - **ethers v5** exposes it at top-level `err.url`; `err.reason` is a
 *     safe summary ("bad response", "missing response", etc.);
 *     `err.message` and `err.stack` echo the full URL the same way.
 *   - **viem** carries it on a plain `err.url` property, inside its
 *     multi-line compound `message`, and in the `metaMessages` array
 *     that its `BaseError` builds. Every wrapping viem error
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
 * ## Redact, don't re-describe
 *
 * The sanitised clone keeps each library's **own field names and
 * structure** — same keys, scrubbed values. A consumer reads
 * `err.response.statusCode` on an ethers v6 error or `err.status` on a
 * viem one exactly as those libraries document, so nothing here invents
 * a parallel vocabulary that would have to be learned, kept in sync, and
 * mapped back.
 *
 * What forces the clone rather than in-place redaction is that the
 * hazardous members are **class instances**: ethers' `FetchRequest`
 * holds the tokenised URL, the auth headers and the request body, and
 * both it and `FetchResponse` keep everything in `#private` fields — so
 * they survive neither `JSON.stringify` nor a spread as anything but
 * `{}`, and their contents are reachable only through getters. viem's
 * `headers` is a fetch `Headers` instance with the same problem. Each is
 * therefore **projected** to a plain object under the same key with the
 * same sub-keys, carrying only the members that cannot hold a
 * credential.
 *
 * This projection is an **egress** step, applied where an error leaves
 * the process (the pino `err` serializer, `serializeError`,
 * `VError.toJSON`). In-process code keeps the genuine ethers/viem
 * instance with its full behaviour; only what gets written out is
 * projected.
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

/**
 * Response headers that survive projection. Two reasons to keep any of
 * them: retry pacing (`retry-after`, `credits-rate-reset` and the
 * `ratelimit-*` family tell a caller how long the provider wants it to
 * wait, instead of it having to guess) and interpreting the body
 * (`content-type` distinguishes a JSON-RPC error from an HTML error page
 * a load balancer produced).
 *
 * An allowlist, not a denylist: a provider that starts returning an
 * auth-bearing response header can then never widen what gets copied,
 * and `authorization` / `cookie` / `set-cookie` are excluded by
 * construction rather than by remembering to name them. Add an entry
 * only after checking it cannot carry a credential.
 */
const SAFE_HEADER_NAMES = new Set(['retry-after', 'credits-rate-reset', 'content-type']);
const SAFE_HEADER_PREFIXES = ['ratelimit-'];

function isSafeHeaderName(name: string): boolean {
  return SAFE_HEADER_NAMES.has(name) || SAFE_HEADER_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * The fetch `Headers` shape viem hands us. ethers uses a plain record, so
 * `forEach` is the discriminator: enumeration (not `get`) is what the
 * prefix match needs.
 */
interface HeadersLike {
  forEach(callback: (value: string, key: string) => void): void;
}

function isHeadersLike(value: object): value is HeadersLike {
  return typeof (value as { forEach?: unknown }).forEach === 'function';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/**
 * Project a header bag — a fetch `Headers` instance or a plain record —
 * to a plain record of the allowlisted entries. Names are lowercased so
 * the result is uniform across libraries and case-insensitive lookup
 * isn't needed downstream.
 */
function projectHeaders(headers: unknown): Record<string, string> | undefined {
  const bag = asRecord(headers);
  if (!bag) return undefined;

  const safe: Record<string, string> = {};
  const keep = (value: unknown, key: string): void => {
    const name = key.toLowerCase();
    if (!isSafeHeaderName(name) || typeof value !== 'string') return;
    safe[name] = stripUrlsInPlace(value);
  };

  if (isHeadersLike(bag)) bag.forEach(keep);
  else for (const [key, value] of Object.entries(bag)) keep(value, key);

  return safe;
}

/**
 * ethers' `FetchResponse` → a plain object under the same key with the
 * same sub-keys. The body is excluded: it is the one member whose size is
 * unbounded, and v6 already exposes the text safely at
 * `info.responseBody`.
 */
function projectResponse(response: unknown): Record<string, unknown> | undefined {
  const source = asRecord(response);
  if (!source) return undefined;

  const projected: Record<string, unknown> = {};
  if (typeof source.statusCode === 'number') projected.statusCode = source.statusCode;
  if (typeof source.statusMessage === 'string') {
    projected.statusMessage = stripUrlsInPlace(source.statusMessage);
  }
  const headers = projectHeaders(source.headers);
  if (headers) projected.headers = headers;
  return projected;
}

/**
 * ethers' `FetchRequest` → a plain object under the same key. Only the
 * URL's origin and the HTTP method: the request headers hold the
 * `authorization` credential and the body holds the JSON-RPC payload,
 * neither of which is ours to republish. The URL is reduced to a bare
 * origin rather than merely having its query stripped, because some
 * gateways put the key in the *path*.
 */
function projectRequest(request: unknown): Record<string, unknown> | undefined {
  const source = asRecord(request);
  if (!source) return undefined;

  const projected: Record<string, unknown> = {};
  if (typeof source.url === 'string') projected.url = tryOrigin(source.url);
  if (typeof source.method === 'string') projected.method = source.method;
  return projected;
}

/**
 * The library-native fields to project onto the sanitised clone: the same
 * key names the library used, with scrubbed values. A `null` detection
 * means "not this library's shape".
 */
type Projection = Record<string, unknown>;

type ErrorLike = Error & Record<string, unknown>;

/**
 * Ethers v6 fingerprint: `err.info` is an object containing `requestUrl`.
 * Preserves all other info fields (e.g. `responseStatus`, `responseBody`) so
 * operators keep useful debug context; only `requestUrl` is rewritten to
 * its origin.
 *
 * `err.response` and `err.request` are the `FetchResponse`/`FetchRequest`
 * instances, projected to plain objects under their own names. Projecting
 * them is the only way they survive at all: their fields are `#private`,
 * so a serialiser sees `{}` where `err.response.statusCode` should be.
 */
function detectV6(err: ErrorLike): Projection | null {
  const info = err.info;
  if (!info || typeof info !== 'object' || !('requestUrl' in info)) return null;

  const source = info as Record<string, unknown>;
  const safeInfo: Record<string, unknown> = { ...source };
  if (typeof safeInfo.requestUrl === 'string') {
    safeInfo.requestUrl = tryOrigin(safeInfo.requestUrl);
  }

  const projection: Projection = { info: safeInfo };
  if (typeof err.code === 'string') projection.code = err.code;

  const response = projectResponse(err.response);
  if (response) projection.response = response;
  const request = projectRequest(err.request);
  if (request) projection.request = request;

  return projection;
}

/**
 * Ethers v5 fingerprint: top-level string `err.url` alongside an error code
 * that the v5 web layer raises for RPC HTTP failures. Unlike v6, v5 attaches
 * every `Logger.throwError` param — `url`, `body`, `responseText`,
 * `serverError`, etc. — as top-level properties on the error, so the
 * projection names the safe ones explicitly instead of copying the lot:
 * `url` reduced to its origin, plus `code`, `reason`, `status`,
 * `requestMethod` and the allowlisted `headers`. `body`, `responseText`
 * and `requestBody` sit right next to them and stay out — the request
 * payload is not ours to republish, and the response body is already
 * unbounded text the v5 path never promised to carry.
 */
const V5_CODES = new Set(['SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR']);

function detectV5(err: ErrorLike): Projection | null {
  const code = typeof err.code === 'string' ? err.code : null;
  const url = typeof err.url === 'string' ? err.url : null;
  if (!code || !url || !V5_CODES.has(code)) return null;

  const info: Record<string, unknown> = { requestUrl: tryOrigin(url) };
  if (typeof err.status === 'number') info.responseStatus = err.status;

  const projection: Projection = { code, info, url: tryOrigin(url) };
  if (typeof err.reason === 'string') projection.reason = stripUrlsInPlace(err.reason);
  if (typeof err.status === 'number') projection.status = err.status;
  if (typeof err.requestMethod === 'string') projection.requestMethod = err.requestMethod;
  const headers = projectHeaders(err.headers);
  if (headers) projection.headers = headers;

  return projection;
}

/**
 * viem fingerprint: any `BaseError` subclass that carries a URL. All five
 * hold it on a plain `err.url` property as well as in `message` and the
 * `metaMessages` array, and viem's own `getUrl` strips only basic-auth
 * credentials — not a `?token=` query or a key in the path — so every one
 * of them leaks without this. `TimeoutError` and `SocketClosedError` in
 * particular are the shapes a failing endpoint produces most often.
 *
 * `metaMessages` being an array is a viem `BaseError`-specific marker;
 * it makes the fingerprint specific enough that an unrelated library
 * happening to share a class name (`TimeoutError` is not a rare one)
 * won't falsely match.
 *
 * The projection keeps viem's own names: `status` (HTTP status, on
 * `HttpRequestError`), `code` (the numeric JSON-RPC code, on
 * `RpcRequestError`), `details` (which for `RpcRequestError` is the
 * JSON-RPC error message), the URL-stripped `metaMessages`, and `url`
 * reduced to its origin. `err.body` is the *request* payload and stays
 * out; `info` stays the empty object viem errors have always serialised
 * with, since viem has no such field of its own.
 */
const VIEM_URL_BEARING_ERRORS = new Set([
  'HttpRequestError',
  'RpcRequestError',
  'TimeoutError',
  'SocketClosedError',
  'WebSocketRequestError'
]);

function detectViem(err: ErrorLike): Projection | null {
  if (!VIEM_URL_BEARING_ERRORS.has(err.name)) return null;
  if (!Array.isArray(err.metaMessages)) return null;

  const projection: Projection = {
    info: {},
    metaMessages: err.metaMessages.map((line: unknown) =>
      typeof line === 'string' ? stripUrlsInPlace(line) : line
    )
  };
  if (typeof err.url === 'string') projection.url = tryOrigin(err.url);
  if (typeof err.status === 'number') projection.status = err.status;
  if (typeof err.code === 'number') projection.code = err.code;
  if (typeof err.details === 'string') projection.details = stripUrlsInPlace(err.details);
  const headers = projectHeaders(err.headers);
  if (headers) projection.headers = headers;

  return projection;
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
 *   - If this node is the detected RPC fetch error, the detector's
 *     projection is assigned over it: the library's own keys, carrying
 *     scrubbed values, with class instances replaced by plain objects of
 *     the same shape. Fields the projection doesn't name are dropped, so
 *     v5's `body`/`responseText`/`requestBody` and every library's
 *     request headers never reach the clone.
 *   - If it is not the RPC node but carries a generic `info` (typical
 *     VError), that info is preserved as-is. We do not deep-scrub VError
 *     info values: callers own that namespace, and collateral URL-stripping
 *     could mangle intentional data.
 *   - `code` is propagated if present, and overridden by the projection
 *     when the library's own code is not a string (viem's numeric
 *     JSON-RPC code).
 *
 * The clone is a plain `Error` with plain-object fields throughout, which
 * is what lets `serializeError` spread it: everything on it is already
 * safe and already serialisable.
 */
function sanitiseNode(e: Error, projection: Projection | null): Error {
  const clone = new Error(stripUrlsInPlace(e.message));
  clone.name = e.name;
  if (e.stack) clone.stack = stripUrlsInPlace(e.stack);

  const source = e as ErrorLike;
  const sourceShortMessage = source.shortMessage;
  if (typeof sourceShortMessage === 'string') {
    (clone as ErrorLike).shortMessage = stripUrlsInPlace(sourceShortMessage);
  }
  if (typeof source.code === 'string') (clone as ErrorLike).code = source.code;

  if (projection) {
    Object.assign(clone, projection);
  } else if (source.info && typeof source.info === 'object') {
    (clone as ErrorLike).info = source.info;
  }
  return clone;
}

/**
 * If `err` — or any error in its `.cause` chain — looks like an ethers v5,
 * ethers v6, or viem RPC fetch error, returns a sanitised clone of the
 * error: the full cause chain is preserved node-for-node with every
 * `message` and `stack` URL-stripped, the detected node's own fields
 * projected to scrubbed values under the library's own key names, and
 * intermediate `VError`/`WError` wrappers kept intact with their own
 * `info` and stack traces. Returns `null` for any other error shape,
 * letting the caller fall through to default handling.
 *
 * Because the projection keeps native names, a consumer that needs to
 * classify a failure it is about to retry — rate-limited vs upstream 5xx
 * vs an empty-bodied gateway timeout — reads the same fields the library
 * documents (`err.response.statusCode`, `err.status`,
 * `err.response.headers['retry-after']`) rather than fields invented
 * here, and needs no separate capture at the throw site.
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
