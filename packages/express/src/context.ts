import type { RequestHandler } from 'express';

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type { Logger } from '@polygonlabs/logger';

/**
 * Request-scoped logger context, backed by `AsyncLocalStorage`.
 *
 * Every request that runs through `requestContext(rootLogger)` is wrapped in
 * an ALS scope holding a child logger bound with a per-request `requestId`.
 * Any code reached from that request — route handlers, service functions,
 * promise continuations, even async tasks that outlive `res.end()` — can
 * call `getLogger()` and receive the same child logger. That gives every
 * log entry for a request a shared `requestId` for Datadog correlation,
 * without threading a `log` parameter through every function signature and
 * without mutating `Request` globally via a `declare module` augmentation.
 *
 * Pattern credit: the canonical Pino + ALS walkthrough —
 * https://blog.logrocket.com/logging-with-pino-and-asynclocalstorage-in-node-js/
 */

const loggerStorage = new AsyncLocalStorage<Logger>();

/**
 * The `rootLogger` passed to the most recent `requestContext()` call. Used
 * as the fallback return value from `getLogger()` when it's invoked outside
 * an active request scope (startup, top-level cron, one-off scripts).
 *
 * Stored at module scope because a process has exactly one root logger —
 * there is no realistic scenario where a single Node process needs multiple
 * distinct fallbacks. Also not exported: callers should only ever get a
 * logger via `getLogger()`.
 */
let fallbackLogger: Logger | null = null;

/**
 * Express middleware factory. Mount before any route. Takes the root
 * logger, returns a middleware that wraps every request in an ALS scope
 * holding a child logger with a fresh `requestId`.
 *
 * The root logger is also captured for `getLogger()`'s out-of-scope
 * fallback — calling this more than once in a process is supported but
 * only the most recent root logger is retained.
 */
export function requestContext(rootLogger: Logger): RequestHandler {
  fallbackLogger = rootLogger;
  return (_req, _res, next) => {
    const child = rootLogger.child({ requestId: randomUUID() });
    loggerStorage.run(child, () => next());
  };
}

/**
 * Returns the logger for the current execution context. Inside a request
 * scope established by `requestContext()`, this is the per-request child
 * logger carrying the `requestId` binding. Outside a request scope (server
 * startup, standalone cron, test code that didn't enter a scope), this is
 * the most recently supplied root logger.
 *
 * Throws if no `requestContext()` has ever been mounted in this process —
 * because in that case we genuinely have no logger to return and silently
 * substituting a no-op would mask configuration errors.
 *
 * Permissive-fallback design: shared service-layer functions can be called
 * from both an HTTP request (scoped logger, correlated) and from a cron or
 * startup routine (root logger, uncorrelated) without the callsite caring
 * which one it is.
 */
export function getLogger(): Logger {
  const scoped = loggerStorage.getStore();
  if (scoped) return scoped;
  if (fallbackLogger) return fallbackLogger;
  throw new Error(
    '@polygonlabs/express: getLogger() called before requestContext() was ever mounted. ' +
      'Mount `app.use(requestContext(rootLogger))` during server setup, or pass the root logger ' +
      'to a one-off `requestContext(rootLogger)` call at startup to prime the fallback.'
  );
}
