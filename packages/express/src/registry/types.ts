/**
 * Per-operation handler typing.
 *
 * Given a route config (asteasolutions's `RouteConfig` shape, with required
 * `operationId`), derive the typed `req`/`res` shapes the handler should see.
 * Path/query/body parameters narrow to their codec-decoded runtime values
 * (matching what the request validator middleware mutates `req.params`/
 * `req.query`/`req.body` to before the handler runs); `res.json` narrows to
 * the union of all response runtime shapes across status codes; `req.auth`
 * narrows to a record keyed by the operation's declared security schemes
 * with each value the matching auth handler's return type.
 */

import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';

/** A registered route — RouteConfig with required operationId. */
export type Operation = RouteConfig & { operationId: string };

/** A registry's accumulated operations type — keyed by operationId. */
export type OperationsManifest = Record<string, Operation>;

/**
 * Auth handler signature. Receives the in-flight request (after Express
 * has parsed body/query/params but before the registry's own validation
 * middleware runs), returns a principal of any shape, or throws an
 * `HTTPError` subclass (typically `NotAuthenticated` / `Forbidden` from
 * `@polygonlabs/verror`) which `createErrorHandler` answers as 401/403.
 *
 * The return type flows into the operation's `req.auth[schemeName]` field
 * for any operation declaring `security: [{ <schemeName>: [...] }]`.
 */
export type AuthHandler<Principal = unknown> = (req: Request) => Principal | Promise<Principal>;

/**
 * Map of scheme name → auth handler. Constructed by the consumer and passed
 * to `RegistryRouter.auth(handlers)`. The map's keys must exhaustively cover
 * every scheme registered on the registry — missing keys, surplus keys, and
 * wrong-shape handlers are all TS errors at the call site.
 */
export type AuthHandlerMap<SchemeNames extends string> = {
  [K in SchemeNames]: AuthHandler;
};

type ParamsOf<Op> = Op extends { request: { params: infer P } }
  ? P extends z.ZodType
    ? z.output<P>
    : Record<string, string>
  : Record<string, string>;

type QueryOf<Op> = Op extends { request: { query: infer Q } }
  ? Q extends z.ZodType
    ? z.output<Q>
    : Record<string, unknown>
  : Record<string, unknown>;

// RouteConfig wraps the body schema in `{ content: { 'application/json':
// { schema } } }` — walk through the nesting to extract the Zod schema.
type BodyOf<Op> = Op extends {
  request: { body: { content: { 'application/json': { schema: infer S } } } };
}
  ? S extends z.ZodType
    ? z.output<S>
    : unknown
  : unknown;

// Same nesting on responses[code].content['application/json'].schema. The
// runtime body type is the union of every status code's runtime shape.
type ResponseBodyOf<Op> = Op extends { responses: infer R }
  ? {
      [K in keyof R]: R[K] extends {
        content: { 'application/json': { schema: infer S } };
      }
        ? S extends z.ZodType
          ? z.output<S>
          : never
        : never;
    }[keyof R]
  : never;

/**
 * Extract the security scheme names declared on an operation. Looks at the
 * first `SecurityRequirementObject` in the `security` array — the registry
 * router supports AND semantics (single requirement, possibly multiple
 * schemes within it). OR semantics (multiple requirements) is rejected at
 * router setup time, so this single-requirement read is correct.
 */
type SchemeNamesOf<Op> = Op extends {
  security: ReadonlyArray<infer R>;
}
  ? R extends Record<string, ReadonlyArray<unknown>>
    ? Extract<keyof R, string>
    : never
  : never;

/**
 * Extract the principal type from any function shape. Used in place of
 * `AuthHandler<infer P>` because consumers commonly write inline handlers
 * without the `req` parameter (`async () => ...`); contravariance lets
 * those satisfy `AuthHandler` but breaks `infer P` inside the
 * `AuthHandler<infer P>` form. Reading the return type directly works
 * regardless of arity.
 */
type PrincipalOf<F> = F extends (...args: never[]) => infer R ? Awaited<R> : never;

/**
 * Build the typed `req.auth` field for an operation. For every scheme name
 * the operation declares, look up the matching handler in the auth map and
 * surface its principal type. Operations with no `security` get `never`,
 * and the conditional below excludes the auth field entirely from `Request`
 * for those cases (so `req.auth` doesn't appear).
 */
type AuthOf<Op, AuthMap> =
  SchemeNamesOf<Op> extends never
    ? never
    : {
        [K in SchemeNamesOf<Op>]: K extends keyof AuthMap ? PrincipalOf<AuthMap[K]> : never;
      };

/**
 * `TypedRequest<Op, AuthMap>`. Adds an `auth` field when the operation
 * declares security; the field is omitted entirely otherwise so consumers
 * don't see a stray empty object on routes without auth.
 */
export type TypedRequest<Op extends Operation, AuthMap = Record<string, never>> = Request<
  ParamsOf<Op>,
  ResponseBodyOf<Op>,
  BodyOf<Op>,
  QueryOf<Op>
> &
  (AuthOf<Op, AuthMap> extends never ? unknown : { auth: AuthOf<Op, AuthMap> });

export type TypedResponse<Op extends Operation> = Response<ResponseBodyOf<Op>>;

export type Handler<Op extends Operation, AuthMap = Record<string, never>> = (
  req: TypedRequest<Op, AuthMap>,
  res: TypedResponse<Op>,
  next: NextFunction
) => void | Promise<void>;

/**
 * Total handler map keyed by operationId. Required (not Partial) — the
 * `satisfies HandlerMap<Operations>` in the wiring file enforces that every
 * registered operation has a handler at compile time. Missing entries are a
 * TS error before runtime ever touches the map. The optional `AuthMap`
 * generic flows auth-handler return types into per-operation
 * `req.auth[schemeName]` typing.
 */
export type HandlerMap<Ops extends OperationsManifest, AuthMap = Record<string, never>> = {
  [K in keyof Ops]: Handler<Ops[K], AuthMap>;
};

/**
 * Handler map for a registry-builder function. Resolves to the
 * `HandlerMap` keyed by `OperationsOf<F>`, so the consumer doesn't need
 * to import a separate `Operations` type alias from the schemas package.
 *
 * Used with TypeScript's `satisfies` operator for typed per-domain
 * handler bags:
 *
 *     export const messageHandlers = {
 *       createMessage: (req, res) => {...},
 *       listMessages: (req, res) => {...}
 *     } satisfies Partial<HandlerMapFor<typeof buildRegistry, AppAuthMap>>;
 *
 * `Partial<...>` permits per-domain bags that don't cover every
 * operation; the wiring file's `.implement(...)` chain accumulates
 * coverage and `.toExpress()` enforces exhaustiveness at compile time.
 *
 * If the registry returned `{}` for its operations manifest (every
 * registration's chain return was discarded — see
 * `@polygonlabs/openapi-registry` README), `OperationsOf<F>` resolves
 * to a brand string and this type does not produce a usable handler
 * map; the `satisfies` check fails at the consumer site, surfacing the
 * upstream bug.
 */
export type HandlerMapFor<
  F extends () => { ops: Record<string, Operation>; schemes: Record<string, true> },
  AuthMap = Record<string, never>
> =
  ReturnType<F> extends { ops: infer Ops }
    ? Ops extends OperationsManifest
      ? keyof Ops extends never
        ? never
        : HandlerMap<Ops, AuthMap>
      : never
    : never;

/**
 * Auth handler map for a registry-builder function. Resolves to a
 * record keyed by every security scheme name registered on the
 * registry — so the consumer doesn't need a separate `SchemeNames`
 * import:
 *
 *     export const buildAuthHandlers = (service: Service) => ({
 *       ApiKeyAuth: (req: Request) => { ... }
 *     }) satisfies AuthHandlerMapFor<typeof buildRegistry>;
 *
 * The resulting auth-handlers value's `ReturnType` is what consumers
 * pass as the `AuthMap` generic to `HandlerMapFor` so per-operation
 * `req.auth[schemeName]` types line up.
 */
export type AuthHandlerMapFor<
  F extends () => { ops: Record<string, Operation>; schemes: Record<string, true> }
> =
  ReturnType<F> extends { schemes: infer Schemes }
    ? AuthHandlerMap<Extract<keyof Schemes, string>>
    : never;
