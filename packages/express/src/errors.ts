import type { ErrorRequestHandler } from 'express';

import { sanitiseEthersFetchError } from '@polygonlabs/logger';
import { HTTPError } from '@polygonlabs/verror';

import { getLogger } from './context.ts';

/**
 * Global Express error handler. Must be mounted last, after all routes and
 * after `notFoundHandler`. Typed as `ErrorRequestHandler` so Express
 * recognises the 4-argument shape as error-handling middleware.
 *
 * Responsibilities:
 *   - Map `HTTPError` subclass `statusCode` onto the HTTP response status.
 *     Anything that is not an `HTTPError` becomes 500.
 *   - Log 5xx responses at debug level via `getLogger()`, so every entry
 *     inherits the per-request `requestId` for Datadog correlation. 4xx
 *     responses are not logged here — they are client-facing validation
 *     errors, not server faults.
 *   - Sanitise the error before deriving an HTTP response message from it,
 *     so `err.message` — which the service author has implicitly chosen as
 *     the client-visible message by throwing a `VError` or letting the
 *     error bubble unwrapped — never leaks `?token=<secret>` from an
 *     underlying ethers RPC URL.
 *
 * Whether the client sees "Failed to fetch block number: server response
 * 401 Unauthorized (…)" or a terse hand-written string is a service-author
 * choice expressed through `VError` (message folded) vs `WError` (own
 * message only) vs an `HTTPError` subclass — not something this handler
 * overrides. It only ensures that whatever message does bubble up is
 * URL-free.
 *
 * Log-side URL sanitisation happens inside `@polygonlabs/logger`'s pino
 * err serializer, not here — every service that logs an ethers error
 * anywhere (request handler, cron, background worker, unhandled
 * rejection) gets the same protection, not just ones that reach this
 * middleware.
 */
export function createErrorHandler(): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    const status = err instanceof HTTPError ? err.statusCode : 500;

    if (status >= 500) {
      getLogger().debug({ err }, 'unhandled error');
    }

    const sanitised = sanitiseEthersFetchError(err);
    const message =
      sanitised?.message ?? (err instanceof Error ? err.message : 'Internal server error');

    res.status(status).json({ error: true, message });
  };
}
