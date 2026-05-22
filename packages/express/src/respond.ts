import type { Response } from 'express';

import type { HTTPError } from '@polygonlabs/verror';

/**
 * Single source of truth for the framework's error response body shape.
 * Every framework middleware that detects an error and responds directly
 * (request validator, response validator, auth middleware) calls through
 * here so the wire shape is identical across them — `{ error: true,
 * message, info? }` — and matches the canonical `ErrorResponseSchema` /
 * `ValidationErrorResponseSchema` shapes registered for each route's 4xx
 * / 5xx slots.
 *
 * The framework middlewares respond directly rather than passing errors
 * to the global error handler via `next(err)`: it keeps the detection
 * site and the response site colocated, removes the "did someone else
 * already log this?" question from the global handler, and — most
 * importantly — guarantees the body shape the validator emits matches
 * the schema the registry advertised for that status. If 400s went
 * through the global handler, the generic `{ error, message }` shape it
 * emits would not satisfy the route's declared `ValidationErrorResponse`
 * schema (which requires `info`), creating a silent spec-vs-runtime
 * drift. Direct-respond closes that loop.
 */
export function sendErrorResponse(
  res: Response,
  status: number,
  message: string,
  info?: Record<string, unknown>
): void {
  const body: Record<string, unknown> = { error: true, message };
  if (info && Object.keys(info).length > 0) body.info = info;
  res.status(status).json(body);
}

/**
 * Convenience: send an `HTTPError` (or HTTPError subclass) as a response.
 * Used by auth middleware to honour the statusCode and message the auth
 * handler chose by throwing a specific subclass. `info` is surfaced when
 * non-empty (matches the global handler's existing policy).
 */
export function sendHttpErrorResponse(res: Response, err: HTTPError): void {
  sendErrorResponse(res, err.statusCode, err.message, err.info);
}
