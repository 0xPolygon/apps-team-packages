/**
 * Type-accumulating OpenAPIRegistry composition.
 *
 * `TypedRegistry` is a drop-in superset of `OpenAPIRegistry` from
 * `@asteasolutions/zod-to-openapi` — same method names, same parameter shapes,
 * same `definitions` getter the OpenAPI generator reads. The additions are
 * type-level: each `registerPath` call narrows `this`'s `Ops` accumulator and
 * each `registerComponent('securitySchemes', name, …)` call narrows `this`'s
 * `SchemeNames` accumulator, both via `asserts this is X`. The registry's
 * type carries every registered operationId and every registered security
 * scheme name by the time it's returned, with no duplication between the
 * spec and the typed handler binding downstream.
 *
 * Compose your registry inside a function (`buildRegistry()`, in the consumer)
 * — wrapping in a function is what preserves the accumulated narrows across
 * the export boundary. The function's return type is inferred from the final
 * value of `registry`, after every register call has narrowed the receiver.
 *
 * Four preconditions for the asserts narrowing to materialise (skip any one
 * and the narrow silently no-ops):
 *
 *   1. **TS2775**: the variable holding the registry must have an EXPLICIT
 *      type annotation: `const registry: TypedRegistry = new TypedRegistry()`.
 *      `asserts this is X` only narrows variables whose type is syntactically
 *      annotated at the declaration. Inferred types — even from a typed
 *      factory function — don't qualify, which is why no `createTypedRegistry`
 *      helper is provided: it can't bypass the rule, only restate it.
 *   2. **`<const O>`** on `registerPath` and `<const N>` on `registerComponent`
 *      force literal-type inference on the route operationId and the scheme
 *      name, so they survive as literal types in the accumulator instead of
 *      widening to `string`.
 *   3. **Function wrapper**: the narrows only survive the export boundary
 *      when the registry is returned from a function. `export const registry
 *      = …` after the calls loses the narrow at the export boundary.
 *   4. **Phantom witnesses (`declare readonly ops` / `declare readonly schemes`)**
 *      anchor variance. Without each generic appearing in a real return
 *      position somewhere in the class, TypeScript treats them as
 *      variance-unused (bivariant), and `asserts this is X` narrowing
 *      doesn't fire. Don't read these at runtime; they're always the empty
 *      manifest. The OpenAPI spec lives in `definitions`.
 */

import type { OpenAPIRegistry, RouteConfig } from '@asteasolutions/zod-to-openapi';
import type { z } from 'zod';

import { OpenAPIRegistry as OpenAPIRegistryClass } from '@asteasolutions/zod-to-openapi';

/** A registered route — RouteConfig with required operationId. */
export type RouteWithOpId = RouteConfig & { operationId: string };

/** A registry's accumulated operations type — keyed by operationId. */
export type OperationsManifest = Record<string, RouteWithOpId>;

/**
 * Structural shape of an OpenAPI 3.x SecuritySchemeObject. Defined locally
 * rather than imported from `openapi3-ts` to keep the dependency surface
 * minimal — asteasolutions's runtime `registerComponent` validates the full
 * shape, so this is just a sufficient structural type for the public
 * `registerComponent('securitySchemes', …)` overload.
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
 * Drop-in replacement for `OpenAPIRegistry` that accumulates registered
 * operations and security scheme names into the generic parameters via
 * `asserts this is X`.
 *
 * Inherits the rest of the OpenAPIRegistry surface (`register`,
 * `registerParameter`, `registerWebhook`, `definitions`). Code that treats
 * this as a regular `OpenAPIRegistry` sees no behavioural difference — only
 * `registerPath` and `registerComponent('securitySchemes', …)` carry the
 * extra type-level effect, and that effect is invisible to callers that
 * don't read the narrowed type.
 */
/* eslint-disable @typescript-eslint/no-empty-object-type -- the default `{}` is the "no entries yet" identity element for both intersection-based accumulators. `Record<string, never>` would be wrong (forbids any value); `object` doesn't carry the index signature shape we need. */
export class TypedRegistry<
  Ops extends Record<string, RouteWithOpId> = {},
  Schemes extends Record<string, true> = {}
> {
  /* eslint-enable @typescript-eslint/no-empty-object-type */
  private inner: OpenAPIRegistry;

  /**
   * Phantom witness for the `Ops` generic. Required for the
   * `asserts this is X` narrowing on `registerPath` to actually apply —
   * without `Ops` appearing in a real return-position somewhere in the
   * class, TypeScript treats it as variance-unused and the assertion
   * doesn't narrow `this`. Don't read this at runtime; it's always the
   * empty manifest. The OpenAPI spec lives in `definitions`.
   */
  declare readonly ops: Ops;

  /**
   * Phantom witness for the `Schemes` generic. Same role as `ops` — anchors
   * variance so the `asserts this is X` narrowing on
   * `registerSecurityScheme` actually fires. The presence-map shape
   * (`Record<string, true>`) — rather than a string-union with `never`
   * default — works around a TypeScript quirk where `never` defaults break
   * `asserts this is X` narrowing for the second generic. Read scheme
   * names via `keyof Schemes`. Don't read at runtime.
   */
  declare readonly schemes: Schemes;

  constructor() {
    this.inner = new OpenAPIRegistryClass();
  }

  /**
   * Register a path. Same runtime behaviour as `OpenAPIRegistry.registerPath`.
   * The `<const O>` type parameter forces literal-type inference on the route
   * so `operationId` and `path` survive as literal types in the accumulator.
   * The `asserts this is TypedRegistry<...>` narrows the receiver's `Ops` to
   * include the just-registered operation.
   *
   * Requires `operationId` on the route — it's the accumulator key. (RouteConfig
   * upstream types it optional, but every operation that needs typed handler
   * binding must declare one anyway.)
   */
  registerPath<const O extends RouteWithOpId>(
    route: O
  ): asserts this is TypedRegistry<Ops & { [K in O['operationId']]: O }, Schemes> {
    this.inner.registerPath(route);
  }

  /**
   * Compose a domain-helper function into this registry. The helper takes
   * the registry, registers some routes (via `r.registerPath(...)`), and
   * returns it. The asserts narrows `this` to whatever the helper returned —
   * so the caller writes:
   *
   *     const registry: TypedRegistry = new TypedRegistry();
   *     registry.extend(addCoreRoutes);
   *     registry.extend(addBlockRoutes);
   *     registry.extend(addMessageRoutes);
   *     return registry;
   *
   * with each helper accumulating into the same variable. No chaining,
   * statement-form, zero per-helper boilerplate. The asserted type derives
   * from the helper's inferred return — adding or removing a registerPath
   * inside the helper updates the accumulated type automatically. A
   * misbehaving helper that drops `Ops` or `SchemeNames` can't actually
   * reduce the accumulator: `asserts this is X` is intersected with the
   * current `this`, so existing entries survive.
   */
  extend<R extends TypedRegistry<Record<string, RouteWithOpId>, Record<string, true>>>(
    fn: (r: this) => R
  ): asserts this is R {
    fn(this);
  }

  /**
   * Register a security scheme. Narrows `SchemeNames` to include the literal
   * `name`, so downstream consumers (the Express registry-router's `.auth()`
   * binding) can require an auth handler for every registered scheme at
   * compile time. Runtime delegates to
   * `inner.registerComponent('securitySchemes', name, scheme)` — the OpenAPI
   * generator reads the scheme from `definitions` exactly as it would for a
   * raw `registerComponent` call.
   *
   * Split from `registerComponent` deliberately: the type-level narrow only
   * fires for the `'securitySchemes'` case, and a dedicated method captures
   * that intent at the call site rather than hiding it inside an overload's
   * conditional asserts that gets confused by inference.
   */
  registerSecurityScheme<const N extends string>(
    name: N,
    scheme: SecuritySchemeObject
  ): asserts this is TypedRegistry<Ops, Schemes & { [K in N]: true }> {
    this.inner.registerComponent('securitySchemes', name, scheme);
  }

  /**
   * Generic component registration — schemas, parameters, headers, links,
   * callbacks, pathItems, requestBodies, responses, examples. No type-level
   * effect on the registry's accumulators; the OpenAPI generator reads
   * everything via `definitions`.
   *
   * For security schemes use `registerSecurityScheme`, which carries the
   * narrowing on `SchemeNames` that downstream `.auth()` binding requires.
   */
  registerComponent(
    ...args: Parameters<OpenAPIRegistry['registerComponent']>
  ): ReturnType<OpenAPIRegistry['registerComponent']> {
    return this.inner.registerComponent(...args);
  }

  // Forward the rest of the OpenAPIRegistry surface so consumers treating
  // this as a plain registry (the OpenAPI generator, anything reading
  // `.definitions`) see no behavioural difference. Return types are inferred
  // from the inner methods to avoid depending on package-internal type names
  // that aren't part of the published API.
  register<T extends z.ZodType>(refId: string, schema: T): T {
    return this.inner.register(refId, schema);
  }

  registerParameter<T extends z.ZodType>(refId: string, schema: T): T {
    return this.inner.registerParameter(refId, schema);
  }

  registerWebhook(webhook: RouteConfig): void {
    this.inner.registerWebhook(webhook);
  }

  get definitions(): OpenAPIRegistry['definitions'] {
    return this.inner.definitions;
  }
}
