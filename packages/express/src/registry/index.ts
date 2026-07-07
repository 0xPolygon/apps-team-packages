/**
 * Registry-driven Express router.
 *
 * `createRegistryRouter({ registry })` produces a router whose routes are
 * derived entirely from the operations registered on the OpenAPIRegistry
 * (or `TypedRegistry`). Handlers are bound by `operationId`; the registered
 * Zod schemas validate the request (params, query, body, headers) and
 * response body — codecs round-trip end-to-end on both sides. For each
 * operation declaring `security: [...]` the configured auth handler runs
 * after request validation, so auth handlers (and everything downstream)
 * only ever see well-formed, codec-decoded requests — a malformed request
 * gets its 400 without any auth handler running.
 *
 * Three correctness gates, all enforced at compile time:
 *
 *   - `.auth(handlers)` requires a handler for every security scheme
 *     registered on the registry. Missing keys, surplus keys, and
 *     wrong-shape handlers are TS errors. The handler return types flow
 *     into per-operation `req.auth[schemeName]` typing.
 *   - `.implement(handlers)` requires a handler for every registered
 *     operation. Missing keys / surplus keys are TS errors.
 *   - The registry must be a `TypedRegistry` so the operations and security
 *     schemes accumulators are visible to the router type. Plain
 *     `OpenAPIRegistry` falls back to a permissive runtime view.
 */

import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import type { Request, RequestHandler, Router as RouterType } from 'express';

import { Router } from 'express';

import { HTTPError } from '@polygonlabs/verror';

import type { ZodErrorTree } from './errorSchemas.ts';
import type {
  AuthHandler,
  AuthHandlerMap,
  Handler,
  HandlerMap,
  Operation,
  OperationsManifest
} from './types.ts';

import { sendErrorResponse, sendHttpErrorResponse } from '../respond.ts';
import { openApiToExpressPath } from './pathMatching.ts';
import { createRequestValidator, createResponseValidator } from './validation.ts';

/**
 * Extract the operations accumulator from a `TypedRegistry`. Reads the
 * phantom `ops` field directly rather than pattern-matching on the generic
 * parameters — the generic-pattern form falls back to the constraint upper
 * bound (`OperationsManifest`) instead of the actual narrowed type.
 */
export type RegistryOps<R> = R extends { ops: infer Ops }
  ? Ops extends OperationsManifest
    ? Ops
    : OperationsManifest
  : OperationsManifest;

/**
 * Extract the security-scheme name union from a `TypedRegistry`. Reads the
 * phantom `schemes` field directly (same reason as `RegistryOps`). Falls
 * back to `never` when the registry has no schemes accumulated — `.auth()`
 * on a registry with no security schemes takes an empty handler map.
 */
export type RegistrySchemes<R> = R extends { schemes: infer Schemes }
  ? Extract<keyof Schemes, string>
  : never;

/**
 * Walks `registry.definitions` to recover every registered route. The
 * registry's own type erases the per-call types, so we widen to `Operation`
 * here — handlers receive the typed view via `Ops` (the generic parameter)
 * which carries the accumulated literal types.
 */
function listRegistryOperations(registry: { definitions: unknown[] }): Operation[] {
  const out: Operation[] = [];
  for (const def of registry.definitions) {
    if (def && typeof def === 'object' && (def as { type?: unknown }).type === 'route') {
      const route = (def as { route: RouteConfig }).route;
      if (typeof route.operationId === 'string') {
        out.push(route as Operation);
      }
    }
  }
  return out;
}

export type RegistryRouterConfig<R> = { registry: R };

/**
 * Type-level "missing handlers" report used as the `this:` annotation for
 * `toExpress()` when `Implemented` doesn't cover every key in `Ops`. The
 * brand `__missingHandlers` is unique enough that consumers see it in the
 * TS error message; the literal-type union of missing operationIds is the
 * actual diagnostic value.
 */
type MissingHandlersError<Missing> = {
  readonly __error: 'Missing handlers — call .implement(...) for these operations before .toExpress()';
  readonly __missingHandlers: Missing;
};

export class RegistryRouter<
  Ops extends OperationsManifest,
  SchemeNames extends string,
  AuthMap = Record<string, never>,
  Implemented extends keyof Ops = never
> {
  private readonly registry: { definitions: unknown[] };
  private handlers: Partial<HandlerMap<Ops, AuthMap>> = {};
  private authHandlers: Record<string, AuthHandler> | undefined;

  constructor(registry: { definitions: unknown[] }) {
    this.registry = registry;
  }

  /**
   * Bind auth handlers — one per registered security scheme. Type-level
   * exhaustiveness via two intersected constraints:
   *
   *   1. `H extends AuthHandlerMap<SchemeNames>` — every registered scheme
   *      must have a handler (missing keys = TS error).
   *   2. The `& { [K in Exclude<keyof H, SchemeNames>]: never }` slice
   *      forbids surplus keys: any key in `H` that is NOT a registered
   *      scheme name has value type `never`, which a real handler can't
   *      satisfy.
   *
   * Handler return types flow into per-operation `req.auth[schemeName]`
   * typing via the `AuthMap` generic on the returned router. Returns a
   * re-typed router (rather than mutating in place via asserts) because
   * `.implement(handlers)` immediately downstream needs to read the
   * concrete handler shapes — `asserts this is X` doesn't let downstream
   * methods see narrowed generics on the receiver.
   */
  auth<const H extends AuthHandlerMap<SchemeNames>>(
    handlers: H & { [K in Exclude<keyof H, SchemeNames>]: never }
  ): RegistryRouter<Ops, SchemeNames, H, Implemented> {
    this.authHandlers = handlers as Record<string, AuthHandler>;
    return this as unknown as RegistryRouter<Ops, SchemeNames, H, Implemented>;
  }

  /**
   * Bind a (possibly partial) handler bag. Multiple `.implement()` calls
   * accumulate — handler bags from separate modules can be composed at the
   * wiring site:
   *
   *     const router = createRegistryRouter({ registry })
   *       .auth(authHandlers)
   *       .implement(statusHandlers)
   *       .implement(managementHandlers);
   *     const expressRouter = router.toExpress();
   *
   * Type-level guarantees, all enforced at the call site:
   *
   *   - Each handler's `req` / `res` are narrowed to the operation's typed
   *     view (`TypedRequest<Op, AuthMap>` etc).
   *   - Surplus keys (not present in `Ops`) are TS errors via the
   *     `Exclude<keyof H, keyof Ops>` slice — typos at the implement site
   *     fail close to the source instead of surfacing as drift later.
   *   - The router's `Implemented` accumulator narrows to add `keyof H`,
   *     which `.toExpress()` later checks for completeness.
   *
   * Calling `.implement({})` is a no-op (legal). Operations not covered by
   * any `.implement()` call cause a TS error at `.toExpress()`, with the
   * missing operationIds visible in the diagnostic.
   */
  implement<const H extends Partial<HandlerMap<Ops, AuthMap>>>(
    handlers: H & { [K in Exclude<keyof H, keyof Ops>]: never }
  ): RegistryRouter<Ops, SchemeNames, AuthMap, Implemented | (keyof H & keyof Ops)> {
    Object.assign(this.handlers, handlers);
    return this as unknown as RegistryRouter<
      Ops,
      SchemeNames,
      AuthMap,
      Implemented | (keyof H & keyof Ops)
    >;
  }

  /**
   * Materialise the configured operations as an Express Router with auth
   * (when declared) and validators wrapping each handler. Mount at the app
   * root — operation paths in the registry are absolute.
   *
   * The `this:` type guard enforces exhaustiveness: when `Implemented`
   * doesn't cover every operation in the registry, the receiver type
   * resolves to `MissingHandlersError<Missing>` instead of `this`, and the
   * call fails to typecheck with the missing operationIds visible in the
   * error. Add the missing handlers via `.implement(...)` (one or more
   * calls) and the call type-checks.
   *
   * Also throws at runtime when:
   *   - an operation declares OR-style security (`security: [{...}, {...}]`
   *     — multiple alternative requirements). Only AND semantics
   *     (single-requirement object, possibly with multiple schemes) are
   *     supported.
   *   - an operation declares a security scheme that has no auth handler
   *     bound (which `.auth()`'s type-level exhaustiveness already
   *     prevents at compile time, so this is purely defence-in-depth).
   */
  toExpress(
    this: [Exclude<keyof Ops, Implemented>] extends [never]
      ? RegistryRouter<Ops, SchemeNames, AuthMap, Implemented>
      : MissingHandlersError<Exclude<keyof Ops, Implemented>>
  ): RouterType {
    // The `this:` annotation gates the call at compile time. Inside the
    // function body, `this` is widened back to the concrete router (the
    // type-only guard doesn't change the runtime).
    const self = this as unknown as RegistryRouter<Ops, SchemeNames, AuthMap, Implemented>;
    const handlers = self.handlers;
    const authHandlers = self.authHandlers ?? {};

    const router = Router();

    for (const op of listRegistryOperations(self.registry)) {
      const handler = (handlers as Record<string, Handler<Operation>>)[op.operationId];
      if (!handler) {
        // Defence in depth — the type system prevents this when the wiring
        // file uses `satisfies HandlerMap<Operations>`.
        throw new Error(`RegistryRouter: no handler for operation '${op.operationId}'`);
      }

      const expressPath = openApiToExpressPath(op.path);
      const middlewares: RequestHandler[] = [];

      // Request validation runs before auth: a malformed request 400s
      // immediately, and auth handlers only fire on well-formed requests —
      // they can trust the validated, codec-decoded req.params/query/body
      // instead of re-parsing (shadow-schema) the raw input themselves.
      middlewares.push(createRequestValidator(op));

      const authMiddleware = createAuthMiddleware(op, authHandlers);
      if (authMiddleware) {
        middlewares.push(authMiddleware);
      }

      middlewares.push(
        createResponseValidator(op),
        // Express 5 catches async errors raised by handlers natively, so no
        // try/catch wrapper is needed here. The cast is structural — Handler
        // narrows req/res types beyond what RequestHandler declares, and
        // Express only ever invokes it with the broad shape it knows about.
        handler as unknown as RequestHandler
      );

      // The cases must cover every member of asteasolutions's `Method` union
      // (`get` | `post` | `put` | `delete` | `patch` | `head` | `options` |
      // `trace`). The `default` branch is an exhaustiveness gate: if the
      // upstream union grows, the `_exhaustive: never` assignment fails to
      // compile and the runtime throw fires defence-in-depth. Without it,
      // an unhandled method would silently mount nothing and the route
      // would 404 at request time.
      switch (op.method) {
        case 'get':
          router.get(expressPath, ...middlewares);
          break;
        case 'post':
          router.post(expressPath, ...middlewares);
          break;
        case 'put':
          router.put(expressPath, ...middlewares);
          break;
        case 'patch':
          router.patch(expressPath, ...middlewares);
          break;
        case 'delete':
          router.delete(expressPath, ...middlewares);
          break;
        case 'head':
          router.head(expressPath, ...middlewares);
          break;
        case 'options':
          router.options(expressPath, ...middlewares);
          break;
        case 'trace':
          router.trace(expressPath, ...middlewares);
          break;
        default: {
          const _exhaustive: never = op.method;
          throw new Error(
            `RegistryRouter: operation '${op.operationId}' uses unsupported method '${_exhaustive as string}'`
          );
        }
      }
    }

    return router;
  }
}

/**
 * Build an auth middleware for a single operation. Returns `undefined` when
 * the operation has no `security` declaration (so the caller doesn't mount
 * an unnecessary middleware). Throws at construction time on configuration
 * errors — OR-style security (multiple requirements), or a referenced
 * scheme name with no registered handler.
 */
function createAuthMiddleware(
  op: Operation,
  authHandlers: Record<string, AuthHandler>
): RequestHandler | undefined {
  const security = op.security;
  if (!security || security.length === 0) return undefined;

  if (security.length > 1) {
    throw new Error(
      `@polygonlabs/express/registry: operation '${op.operationId}' declares ` +
        `OR-style security (multiple alternative requirement objects), which is ` +
        `not supported. Combine schemes within a single requirement object for ` +
        `AND semantics, e.g. \`security: [{ apiKey: [], bearer: [] }]\`.`
    );
  }

  const requirement = security[0] as Record<string, ReadonlyArray<unknown>>;
  const schemeNames = Object.keys(requirement);

  const handlersForOp: Array<{ name: string; handler: AuthHandler }> = [];
  for (const name of schemeNames) {
    const handler = authHandlers[name];
    if (!handler) {
      throw new Error(
        `@polygonlabs/express/registry: operation '${op.operationId}' references ` +
          `security scheme '${name}', but no auth handler was registered for that ` +
          `scheme. Pass it to \`.auth({ ${name}: ... })\`.`
      );
    }
    handlersForOp.push({ name, handler });
  }

  return async (req, res, next) => {
    try {
      const auth: Record<string, unknown> = {};
      for (const { name, handler } of handlersForOp) {
        auth[name] = await handler(req);
      }
      // Attach the resolved principals to the request for the downstream
      // handler. Cast through `unknown` because Express's `Request` is too
      // wide to express the typed `auth` field; the per-operation Handler
      // type sees it via TypedRequest's intersection.
      (req as Request & { auth?: Record<string, unknown> }).auth = auth;
      next();
    } catch (err) {
      // Respond directly. The auth handler is user code: it picks the
      // status by throwing a specific HTTPError subclass (NotAuthenticated,
      // Forbidden, etc.). We honour that choice. A non-HTTPError throw
      // means the auth handler had an unexpected failure — default to 401
      // with a generic message so credentials-validation failures don't
      // surface as 500s. No log on 4xx (client fault); a 5xx from a
      // handler-thrown HTTPError is expected to have been logged by the
      // auth handler before the throw (team convention).
      if (err instanceof HTTPError) {
        sendHttpErrorResponse(res, err);
        return;
      }
      sendErrorResponse(res, 401, 'authentication failed');
    }
  };
}

/**
 * Constrain the registry argument structurally rather than via
 * `R extends TypedRegistry<...>`. The nominal-form constraint causes
 * TypeScript to widen R to the constraint's upper bound during inference
 * (so `Ops` falls back to `OperationsManifest` and the exhaustiveness gate
 * can never close). The structural form lets R infer to the actual
 * narrowed type with `ops`/`schemes` literal-typed.
 */
export function createRegistryRouter<
  R extends { definitions: unknown[]; ops?: unknown; schemes?: unknown }
>(config: RegistryRouterConfig<R>): RegistryRouter<RegistryOps<R>, RegistrySchemes<R>> {
  return new RegistryRouter<RegistryOps<R>, RegistrySchemes<R>>(
    config.registry as { definitions: unknown[] }
  );
}

export type {
  AuthHandler,
  AuthHandlerMap,
  AuthHandlerMapFor,
  Handler,
  HandlerMap,
  HandlerMapFor,
  Operation,
  OperationsManifest,
  TypedRequest,
  TypedResponse
} from './types.ts';
export type { MissingHandlersError, ZodErrorTree };
export type { OperationsOf, SchemesOf } from '@polygonlabs/openapi-registry';
export {
  ErrorResponseSchema,
  ValidationErrorInfoSchema,
  ValidationErrorResponseSchema,
  ZodErrorTreeSchema
} from './errorSchemas.ts';
export { openApiToExpressPath, expressToOpenApiPath } from './pathMatching.ts';
