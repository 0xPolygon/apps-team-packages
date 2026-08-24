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
import type { z } from 'zod';

import { ErrorResponseSchema, ValidationErrorResponseSchema } from './error-schemas.ts';

/**
 * Configuration for the standard-error injection, accepted by
 * `new TypedRegistry({ standardErrorResponses })` and by
 * `inferStandardErrorResponses` directly.
 *
 * The DEFAULT schemas document `@polygonlabs/express`'s error middleware
 * (`createErrorHandler` / `createRequestValidator`) — that coupling is
 * correct for our Express services but wrong for any other producer: a
 * spec authored with this registry for a non-Express service would
 * otherwise advertise 500/400/401 shapes its server never emits, and the
 * injected `ErrorResponse` component name can collide with the service's
 * own same-named schema of a different shape (surfacing as a mangled
 * `allOf` in the generated document).
 *
 *   - `false` — inject nothing. Every route documents exactly the
 *     responses it declares.
 *   - `{ serverError?, validationError?, notAuthenticated? }` — override
 *     the schema for individual slots; omitted slots keep the
 *     `@polygonlabs/express` defaults. The injection RULES (when a 400 /
 *     401 / 500 is added) are unchanged — only the shapes are
 *     configurable, because the rules describe which failures a fronting
 *     framework emits, not what they look like.
 */
export type StandardErrorOptions =
  | false
  | {
      /** Shape of the unconditional 500. Default: `ErrorResponseSchema`. */
      serverError?: z.ZodType;
      /**
       * Shape of the 400 injected for routes declaring request
       * validation. Default: `ValidationErrorResponseSchema`.
       */
      validationError?: z.ZodType;
      /**
       * Shape of the 401 injected for routes declaring `security`.
       * Default: `ErrorResponseSchema`.
       */
      notAuthenticated?: z.ZodType;
    };

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
 *
 * `options` selects the injected shapes (or disables injection) — see
 * {@link StandardErrorOptions}. Omitted (or `{}`) keeps the
 * `@polygonlabs/express` defaults, preserving the original behaviour.
 */
export function inferStandardErrorResponses(
  route: RouteShapeForInference,
  options: StandardErrorOptions = {}
): Record<number, ResponseConfig> {
  if (options === false) {
    return {};
  }

  const serverError = options.serverError ?? ErrorResponseSchema;
  const validationError = options.validationError ?? ValidationErrorResponseSchema;
  const notAuthenticated = options.notAuthenticated ?? ErrorResponseSchema;

  const responses: Record<number, ResponseConfig> = {
    500: {
      description: 'Internal server error.',
      content: { 'application/json': { schema: serverError } }
    }
  };

  const req = route.request;
  const hasRequestValidation = !!(req && (req.params || req.query || req.body || req.headers));
  if (hasRequestValidation) {
    responses[400] = {
      description: 'Request failed schema validation.',
      content: { 'application/json': { schema: validationError } }
    };
  }

  if (route.security && route.security.length > 0) {
    responses[401] = {
      description: 'Missing or invalid credentials.',
      content: { 'application/json': { schema: notAuthenticated } }
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
export type InferredStandardErrorResponses<
  R,
  E extends StandardErrorOptions = DefaultErrors
> = E extends false
  ? // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- injection disabled: identity element for the responses merge
    {}
  : {
      500: {
        description: string;
        content: { 'application/json': { schema: ResolvedServerError<E> } };
      };
    } & (R extends { request: { params: unknown } }
      ? ValidationResponseEntry<E>
      : R extends { request: { query: unknown } }
        ? ValidationResponseEntry<E>
        : R extends { request: { body: unknown } }
          ? ValidationResponseEntry<E>
          : R extends { request: { headers: unknown } }
            ? ValidationResponseEntry<E>
            : // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- identity element for an intersection
              {}) &
      (R extends { security: readonly [unknown, ...unknown[]] }
        ? NotAuthenticatedResponseEntry<E>
        : // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- identity element for an intersection
          {});

/**
 * The "all defaults" options value — `{}` at both type and runtime level.
 * Named so the class's third type parameter reads as intent rather than
 * a bare `{}`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- `{}` IS the value: every slot omitted, every default applied
export type DefaultErrors = {};

/** Schema type for the injected 500 under options `E`. */
type ResolvedServerError<E> = E extends { serverError: infer S extends z.ZodType }
  ? S
  : typeof ErrorResponseSchema;

/** Schema type for the injected 400 under options `E`. */
type ResolvedValidationError<E> = E extends { validationError: infer S extends z.ZodType }
  ? S
  : typeof ValidationErrorResponseSchema;

/** Schema type for the injected 401 under options `E`. */
type ResolvedNotAuthenticated<E> = E extends { notAuthenticated: infer S extends z.ZodType }
  ? S
  : typeof ErrorResponseSchema;

type ValidationResponseEntry<E> = {
  400: {
    description: string;
    content: { 'application/json': { schema: ResolvedValidationError<E> } };
  };
};

type NotAuthenticatedResponseEntry<E> = {
  401: {
    description: string;
    content: { 'application/json': { schema: ResolvedNotAuthenticated<E> } };
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
export type MergedRoute<
  R extends { responses: Record<string | number, unknown> },
  E extends StandardErrorOptions = DefaultErrors
> = Omit<R, 'responses'> & {
  responses: Omit<InferredStandardErrorResponses<R, E>, keyof R['responses']> & R['responses'];
};
