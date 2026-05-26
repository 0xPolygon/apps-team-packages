import type { ErrorRequestHandler } from 'express';

import { HTTPError, serializeError } from '@polygonlabs/verror';

import { getLogger } from './context.ts';

/**
 * Global Express error handler. Must be mounted last, after all routes and
 * after `notFoundHandler`. Typed as `ErrorRequestHandler` so Express
 * recognises the 4-argument shape as error-handling middleware.
 *
 * Responsibilities:
 *   - Map `HTTPError` subclass `statusCode` onto the HTTP response status.
 *     Anything that is not an `HTTPError` becomes 500.
 *   - Log non-`HTTPError` throws at error level via `getLogger()` — they
 *     are unhandled server faults that nothing else in the request
 *     lifecycle has logged. `HTTPError` throws are not logged here: the
 *     thrower is expected to have logged the cause before wrapping (the
 *     standard "use WError / HTTPError at boundaries" convention), and
 *     4xx is itself the client's signal.
 *   - Sanitise the error before deriving an HTTP response message from it,
 *     so `err.message` — which the service author has implicitly chosen as
 *     the client-visible message by throwing a `VError` or letting the
 *     error bubble unwrapped — never leaks `?token=<secret>` from an
 *     underlying RPC URL (ethers v5/v6 or viem).
 *
 * Whether the client sees "Failed to fetch block number: server response
 * 401 Unauthorized (…)" or a terse hand-written string is a service-author
 * choice expressed through `VError` (message folded) vs `WError` (own
 * message only) vs an `HTTPError` subclass — not something this handler
 * overrides. It only ensures that whatever message does bubble up is
 * URL-free.
 *
 * Log-side URL sanitisation happens inside `@polygonlabs/logger`'s pino
 * err serializer, not here — every service that logs an RPC error
 * anywhere (request handler, cron, background worker, unhandled
 * rejection) gets the same protection, not just ones that reach this
 * middleware. Persistence-side sanitisation runs inside
 * `@polygonlabs/verror`'s `serializeError` / `VError.toJSON`, covering
 * Firestore writes, status routes, Sentry events, and `JSON.stringify`.
 */
export function createErrorHandler(): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    if (!(err instanceof HTTPError)) {
      getLogger().error({ err }, 'unhandled error');
    }

    const status = err instanceof HTTPError ? err.statusCode : 500;
    // `serializeError` auto-sanitises RPC fetch errors (ethers v5/v6,
    // viem) — its `message` field is URL-free even when `err.message`
    // would have leaked a `?token=<secret>` from an underlying RPC URL.
    // Non-RPC errors pass through untouched.
    const serialized = serializeError(err);
    const message =
      (typeof serialized?.message === 'string' ? serialized.message : undefined) ??
      (err instanceof Error ? err.message : 'Internal server error');

    const body: Record<string, unknown> = { error: true, message };

    // Surface structured `info` from HTTPError instances so callers can read
    // it directly off the response body. The author of an HTTPError throw
    // site has explicitly chosen the error class for client-facing
    // semantics, so attaching info to the response is opt-in by class
    // choice. Plain Errors (status 500) and HTTPError without info do not
    // expose anything beyond `error` and `message`.
    if (err instanceof HTTPError && err.info && Object.keys(err.info).length > 0) {
      body.info = err.info;
    }

    res.status(status).json(body);
  };
}
