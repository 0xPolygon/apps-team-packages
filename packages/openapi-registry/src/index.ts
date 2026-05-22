/**
 * Type-accumulating OpenAPIRegistry composition.
 *
 * `TypedRegistry` is a drop-in superset of `OpenAPIRegistry` from
 * `@asteasolutions/zod-to-openapi` — same `definitions` getter the OpenAPI
 * generator reads, same runtime behaviour for every method. The additions
 * are type-level: `registerPath` and `registerSecurityScheme` return a
 * narrower `TypedRegistry` whose `Ops` and `Schemes` accumulators include
 * the just-registered entry. Composition uses the standard fluent-builder
 * pattern — chain calls, and the variable holding the final result picks
 * up the accumulated narrow without any annotation:
 *
 *     export const buildRegistry = () =>
 *       new TypedRegistry()
 *         .registerSecurityScheme('ApiKeyAuth', { type: 'apiKey', name: 'x-api-key', in: 'header' })
 *         .with(addCoreRoutes)
 *         .with(addBlockRoutes);
 *
 *     export type Operations = OperationsOf<typeof buildRegistry>;
 *
 * The narrow flows through inferred return types into downstream consumers
 * (Express request/response validation and auth binding, codegen audits,
 * gateway aggregation) without per-step type annotations.
 *
 * The single rule the chainable shape relies on: every registration call
 * returns a value that must be either chained or captured. A discarded
 * return drops the type-level narrow even though the runtime side effect
 * still happens. Two defences:
 *
 *   - `OperationsOf<typeof buildRegistry>` brands the fully-empty case
 *     so a registry that lost every narrow surfaces as a type-level
 *     error at the consumer site.
 *   - `@polygonlabs/apps-team-lint`'s `polygon/no-discarded-typed-registry-chain` rule
 *     catches partial mid-chain discards at lint time — the case the
 *     type-level brand can't see. Type-aware, only fires on real
 *     `TypedRegistry` receivers, enabled at `error` in the
 *     `typescript()` preset.
 */

import type { OpenAPIRegistry, RouteConfig } from '@asteasolutions/zod-to-openapi';
import type { z } from 'zod';

import { OpenAPIRegistry as OpenAPIRegistryClass } from '@asteasolutions/zod-to-openapi';

import type { MergedRoute } from './inferErrorResponses.ts';

import { inferStandardErrorResponses } from './inferErrorResponses.ts';

/** A registered route — RouteConfig with required operationId. */
export type RouteWithOpId = RouteConfig & { operationId: string };

/** A registry's accumulated operations type — keyed by operationId. */
export type OperationsManifest = Record<string, RouteWithOpId>;

/**
 * Structural shape of an OpenAPI 3.x SecuritySchemeObject. Defined locally
 * rather than imported from `openapi3-ts` to keep the dependency surface
 * minimal — asteasolutions's runtime `registerComponent` validates the full
 * shape, so this is just a sufficient structural type for the public
 * `registerSecurityScheme` parameter.
 */
export type SecuritySchemeObject = {
  type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect';
  description?: string;
  /** apiKey only. */
  name?: string;
  /** apiKey only. */
  in?: 'query' | 'header' | 'cookie';
  /** http only. */
  scheme?: string;
  /** http bearer only. */
  bearerFormat?: string;
  /** oauth2 only. */
  flows?: Record<string, unknown>;
  /** openIdConnect only. */
  openIdConnectUrl?: string;
};

/**
 * Fluent OpenAPI registry. `registerPath` and `registerSecurityScheme`
 * return a `TypedRegistry` typed with the just-registered entry added;
 * `with(fn)` runs a domain helper and returns the helper's result
 * intersected with the receiver, so a misbehaving helper that drops
 * the parent narrow can't reduce the accumulator.
 *
 * Inherits the rest of the OpenAPIRegistry surface (`register`,
 * `registerParameter`, `registerComponent`, `registerWebhook`,
 * `definitions`). Code that treats this as a regular `OpenAPIRegistry`
 * sees no behavioural difference — only `registerPath` and
 * `registerSecurityScheme` carry the extra type-level effect, and that
 * effect is invisible to callers that don't read the narrowed type.
 */
/* eslint-disable @typescript-eslint/no-empty-object-type -- the default `{}` is the "no entries yet" identity element for both intersection-based accumulators. `Record<string, never>` would be wrong (forbids any value); `object` doesn't carry the index signature shape we need. */
export class TypedRegistry<
  Ops extends Record<string, RouteWithOpId> = {},
  Schemes extends Record<string, true> = {}
> {
  /* eslint-enable @typescript-eslint/no-empty-object-type */
  private inner: OpenAPIRegistry;

  /**
   * Type-level accessor for the accumulated operations manifest. Read via
   * `typeof registry['ops']` or `keyof typeof registry['ops']` from the
   * narrowed value. Empty at runtime — the OpenAPI spec lives in
   * `definitions`. The `OperationsOf<typeof buildFn>` helper is the
   * recommended way to extract this from a builder function, since it
   * also brands the empty case as a type-level error.
   */
  declare readonly ops: Ops;

  /**
   * Type-level accessor for the accumulated security scheme names. Read
   * via `keyof typeof registry['schemes']` from the narrowed value. The
   * presence-map shape (`Record<string, true>`) is what downstream
   * `.auth(handlers)` binding consumes.
   */
  declare readonly schemes: Schemes;

  constructor() {
    this.inner = new OpenAPIRegistryClass();
  }

  /**
   * Register a path. Returns this registry typed with `operationId` added
   * to the `Ops` accumulator. Chain registrations to keep the narrow:
   *
   *     new TypedRegistry()
   *       .registerPath({ operationId: 'a', method: 'get', path: '/a', responses: ... })
   *       .registerPath({ operationId: 'b', method: 'get', path: '/b', responses: ... })
   *
   * The `<const O>` type parameter forces literal-type inference on the
   * route so `operationId` survives as a literal in the accumulator key
   * instead of widening to `string`.
   *
   * Requires `operationId` on the route — it's the accumulator key.
   * (RouteConfig upstream types it optional, but every operation that
   * needs typed handler binding downstream must declare one anyway.)
   *
   * Standard framework-emitted error responses (400 for validation, 401
   * for auth, 500 always) are auto-injected into `responses` based on
   * what the route declares — see `inferErrorResponses.ts` for the rules
   * and rationale. User-authored response slots win over inferred ones,
   * so a route can still override a status code's shape by declaring it.
   */
  registerPath<const O extends RouteWithOpId>(
    route: O
  ): TypedRegistry<Ops & { [K in O['operationId']]: MergedRoute<O> }, Schemes> {
    const merged = {
      ...route,
      responses: {
        ...inferStandardErrorResponses(route),
        ...route.responses
      }
    } as O;
    this.inner.registerPath(merged);
    return this as unknown as TypedRegistry<
      Ops & { [K in O['operationId']]: MergedRoute<O> },
      Schemes
    >;
  }

  /**
   * Register a security scheme. Returns this registry typed with the
   * literal scheme name added to the `Schemes` accumulator, so downstream
   * consumers (the Express registry-router's `.auth(handlers)` binding)
   * can require an exhaustive auth handler map at compile time via
   * `keyof Schemes`.
   *
   * Runtime delegates to
   * `inner.registerComponent('securitySchemes', name, scheme)` — the
   * OpenAPI generator reads the scheme from `definitions` exactly as it
   * would for a raw `registerComponent` call. Split from
   * `registerComponent` deliberately: the type-level narrow only fires
   * for the `'securitySchemes'` case, and a dedicated method captures
   * that intent at the call site rather than hiding it inside an
   * overload's conditional return that gets confused by inference.
   */
  registerSecurityScheme<const N extends string>(
    name: N,
    scheme: SecuritySchemeObject
  ): TypedRegistry<Ops, Schemes & { [K in N]: true }> {
    this.inner.registerComponent('securitySchemes', name, scheme);
    return this as unknown as TypedRegistry<Ops, Schemes & { [K in N]: true }>;
  }

  /**
   * Compose a domain helper into the chain. The helper takes the registry
   * (already narrowed with everything registered before this `.with`
   * call), registers more routes, and returns the chained result:
   *
   *     // helper:
   *     const addBlockRoutes = <Ops, Schemes>(r: TypedRegistry<Ops, Schemes>) =>
   *       r.registerPath({ operationId: 'getBlockNumber', ... })
   *        .registerPath({ operationId: 'getBlockMetadata', ... });
   *
   *     // composition:
   *     export const buildRegistry = () =>
   *       new TypedRegistry()
   *         .with(addCoreRoutes)
   *         .with(addBlockRoutes);
   *
   * Returns `this & R` (the receiver intersected with the helper's
   * inferred return type) so a misbehaving helper that drops the parent
   * narrow — say, by ignoring its argument and constructing a fresh
   * registry — can't actually shrink the accumulator: existing entries
   * survive via the intersection.
   *
   * `void` is rejected at the constraint: a helper that forgets to return
   * the chain is a TS error at the `.with(fn)` call site, not a silent
   * empty manifest downstream.
   */
  with<R extends TypedRegistry<Record<string, RouteWithOpId>, Record<string, true>>>(
    fn: (r: this) => R
  ): this & R {
    fn(this);
    return this as this & R;
  }

  /**
   * Generic component registration — schemas, parameters, headers, links,
   * callbacks, pathItems, requestBodies, responses, examples. No type-level
   * effect on the registry's accumulators; the OpenAPI generator reads
   * everything via `definitions`. Returns the registry for chaining.
   *
   * For security schemes use `registerSecurityScheme`, which carries the
   * narrowing on `Schemes` that downstream `.auth(handlers)` binding
   * requires.
   */
  registerComponent(...args: Parameters<OpenAPIRegistry['registerComponent']>): this {
    this.inner.registerComponent(...args);
    return this;
  }

  /**
   * Register a webhook. Returns the registry for chaining.
   */
  registerWebhook(webhook: RouteConfig): this {
    this.inner.registerWebhook(webhook);
    return this;
  }

  // `register` and `registerParameter` return the registered schema rather
  // than the registry — that's the asteasolutions API and it's load-bearing
  // for typical use:
  //
  //     export const Foo = registry.register('Foo', z.object({ ... }));
  //
  // They don't chain. Use them as expressions rather than chain steps.
  register<T extends z.ZodType>(refId: string, schema: T): T {
    return this.inner.register(refId, schema);
  }

  registerParameter<T extends z.ZodType>(refId: string, schema: T): T {
    return this.inner.registerParameter(refId, schema);
  }

  get definitions(): OpenAPIRegistry['definitions'] {
    return this.inner.definitions;
  }
}

/**
 * Brand applied by `OperationsOf<F>` when the inferred registry's
 * operations manifest is empty. Used as a type-level error message that
 * surfaces in IDE hover and breaks downstream consumers that assume a
 * non-empty manifest.
 */
export type EmptyOperationsManifestError =
  '__ERROR_OPERATIONS_EMPTY: registry returned no operations. A chain return value was likely discarded — chain or capture every registration. The polygon/no-discarded-typed-registry-chain lint rule (in @polygonlabs/apps-team-lint) catches partial discards too. See @polygonlabs/openapi-registry README.';

/**
 * Extract the `Ops` accumulator from a registry-builder function's
 * inferred return type, or surface a type-level error if the manifest
 * is empty.
 *
 * The empty-case brand catches the worst silent failure in the chainable
 * API: a builder where every registration's return was discarded and the
 * registry stays at its `{}` initial type. Downstream code reading
 * `OperationsOf<typeof buildRegistry>` sees the brand string instead of
 * a usable manifest, which surfaces the bug in IDE hover at the consumer
 * site.
 *
 * Partial discards (some calls chained, some discarded) still
 * under-report — the manifest is non-empty but missing entries. The
 * `polygon/no-discarded-typed-registry-chain` ESLint rule from
 * `@polygonlabs/apps-team-lint` (enabled at `error` in the
 * `typescript()` preset) catches that case at lint time.
 */
export type OperationsOf<
  F extends () => TypedRegistry<Record<string, RouteWithOpId>, Record<string, true>>
> =
  ReturnType<F> extends TypedRegistry<infer O, Record<string, true>>
    ? keyof O extends never
      ? EmptyOperationsManifestError
      : O
    : never;

/**
 * Extract the `Schemes` accumulator (a `Record<string, true>` whose keys
 * are the registered security scheme names) from a registry-builder
 * function's inferred return type. Downstream `.auth(handlers)` binding
 * uses `keyof SchemesOf<typeof buildRegistry>` to require an exhaustive
 * auth handler map.
 *
 * No empty-case brand — registries without any security schemes are
 * legitimate (no auth-gated routes), so an empty `Schemes` here is a
 * normal state, not an error.
 */
export type SchemesOf<
  F extends () => TypedRegistry<Record<string, RouteWithOpId>, Record<string, true>>
> = ReturnType<F> extends TypedRegistry<Record<string, RouteWithOpId>, infer S> ? S : never;

// Re-export the inference types and helper from the public surface so
// `tsc --declaration` in consumer packages can name them without needing
// a deep import into `./dist/inferErrorResponses.js`. Without this, `tsc`
// emits TS2742 in consumers whose inferred `buildRegistry` (or chain
// helpers like `addBlockRoutes`) return type references `MergedRoute` —
// the type would only be reachable via the package's internal subpath.
export type { InferredStandardErrorResponses, MergedRoute } from './inferErrorResponses.ts';
export { inferStandardErrorResponses } from './inferErrorResponses.ts';
