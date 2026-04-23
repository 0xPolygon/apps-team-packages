import type { RequestHandler } from 'express';

import { NotFound } from '@polygonlabs/verror';

/**
 * Terminal middleware that throws `NotFound` with the request method and
 * path. Mount just before `createErrorHandler()` so unmatched routes are
 * formatted uniformly — same JSON shape, same log handling, same status
 * code derivation — as any other `HTTPError` thrown from a route handler.
 */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFound(`${req.method} ${req.path}`));
};
