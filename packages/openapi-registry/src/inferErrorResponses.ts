/**
 * Standard-error-response inference for `TypedRegistry.registerPath`.
 *
 * Every route registered against `@polygonlabs/express`'s registry-driven
 * router can produce a fixed set of error responses that the framework
 * itself emits — not the route handler. Forcing every route author to
 * declare them by hand is busywork that drifts: a route adds a body
 * schema and forgets to add the 400 entry; the codegen'd client then has
 * no type for the validation-error shape the server actually returns
 * (the original bug this helper exists to fix).
 *
 * Inference is driven by what the route declares, so the injected slots
 * are precise:
 *
 *   - **400 (validation)** when the route declares any of
 *     `request.{params,query,body,headers}`. The framework's
 *     `createRequestValidator` throws `BadRequest` with a section-keyed
 *     `ValidationErrorInfo` tree; the canonical shape is
 *     `ValidationErrorResponseSchema`. Routes with no request validation
 *     don't get a 400 — the framework can't emit one for them.
 *   - **401 (unauthenticated)** when the route declares `security` with
 *     at least one requirement. The framework's auth middleware throws
 *     `NotAuthenticated`; shape is `ErrorResponseSchema`. Routes with
 *     `security: []` or no `security` block don't get a 401.
 *   - **500 (server error)** unconditionally — every route's handler can
 *     fail. Shape is `ErrorResponseSchema`.
 *
 * What this helper does **not** inject:
 *
 *   - **403** — `Forbidden` is thrown by application-level authorisation
 *     code, not by the framework. The registry can't see which routes do
 *     authz, so it can't honestly advertise a 403.
 *   - **404** — `NotFound` is thrown by handlers when a lookup misses.
 *     Same reason: handler-emitted, not framework-emitted.
 *
 * User-authored responses always win over inferred ones (the merge in
 * `registerPath` spreads `route.responses` last). A route that wants a
 * domain-shaped 400 — or that genuinely can't 500 — can override by
 * declaring the slot itself.
 */

import type { ResponseConfig } from '@asteasolutions/zod-to-openapi';

import { ErrorResponseSchema, ValidationErrorResponseSchema } from './error-schemas.ts';

/**
 * Minimal structural slice of `RouteConfig` that the inference reads.
 * Typed locally rather than importing the full `RouteConfig` so this
 * helper stays independent of asteasolutions's internal shape changes —
 * we only care about the four request keys and the security array.
 */
type RouteShapeForInference = {
  request?: {
    params?: unknown;
    query?: unknown;
    body?: unknown;
    headers?: unknown;
  };
  security?: ReadonlyArray<unknown>;
};

/**
 * Returns the standard error responses inferred from the route's
 * declared shape. Caller merges this with the user-authored responses
 * (user wins) before forwarding to `inner.registerPath`.
 */
export function inferStandardErrorResponses(
  route: RouteShapeForInference
): Record<number, ResponseConfig> {
  const responses: Record<number, ResponseConfig> = {
    500: {
      description: 'Internal server error.',
      content: { 'application/json': { schema: ErrorResponseSchema } }
    }
  };

  const req = route.request;
  const hasRequestValidation = !!(req && (req.params || req.query || req.body || req.headers));
  if (hasRequestValidation) {
    responses[400] = {
      description: 'Request failed schema validation.',
      content: { 'application/json': { schema: ValidationErrorResponseSchema } }
    };
  }

  if (route.security && route.security.length > 0) {
    responses[401] = {
      description: 'Missing or invalid credentials.',
      content: { 'application/json': { schema: ErrorResponseSchema } }
    };
  }

  return responses;
}

/**
 * Type-level version of `inferStandardErrorResponses`. Mirrors the
 * runtime rules exactly so the accumulated `Ops` type carries the same
 * response slots the runtime registry contains, and the codegen client
 * picks them up.
 *
 * The four `request.*` checks are written as separate conditional
 * branches rather than a union (`{ params: unknown } | { query: unknown } | ...`)
 * because TypeScript's structural assignability would let a route with
 * only `params` satisfy the `query` branch trivially. Each conditional
 * narrows on a distinct required-key shape, so only routes that actually
 * declare that key match.
 */
export type InferredStandardErrorResponses<R> = {
  500: {
    description: string;
    content: { 'application/json': { schema: typeof ErrorResponseSchema } };
  };
} & (R extends { request: { params: unknown } }
  ? ValidationResponseEntry
  : R extends { request: { query: unknown } }
    ? ValidationResponseEntry
    : R extends { request: { body: unknown } }
      ? ValidationResponseEntry
      : R extends { request: { headers: unknown } }
        ? ValidationResponseEntry
        : // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- identity element for an intersection
          {}) &
  (R extends { security: readonly [unknown, ...unknown[]] }
    ? NotAuthenticatedResponseEntry
    : // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- identity element for an intersection
      {});

type ValidationResponseEntry = {
  400: {
    description: string;
    content: { 'application/json': { schema: typeof ValidationErrorResponseSchema } };
  };
};

type NotAuthenticatedResponseEntry = {
  401: {
    description: string;
    content: { 'application/json': { schema: typeof ErrorResponseSchema } };
  };
};

/**
 * The route type as it ends up in the accumulator after the merge:
 * user-authored responses win key-by-key, inferred slots fill in the
 * rest. `Omit<Inferred, keyof UserResponses>` is what gives the user
 * priority — the keys the user provided are dropped from the inferred
 * side before the intersection, so the user's response types are the
 * ones that surface.
 */
export type MergedRoute<R extends { responses: Record<string | number, unknown> }> = Omit<
  R,
  'responses'
> & {
  responses: Omit<InferredStandardErrorResponses<R>, keyof R['responses']> & R['responses'];
};
