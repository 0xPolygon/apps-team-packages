/**
 * Type-level assertions for `TypedRegistry`'s chainable shape.
 *
 * Vitest's runtime test runner ignores `.test-d.ts`; the file's signal
 * comes from `tsc --noEmit` (run by `pnpm run typecheck`, which CI gates
 * on). Each `@ts-expect-error` directive succeeds when the line below it
 * IS a type error and FAILS when it isn't, so a regression that flips an
 * assertion either way fails the typecheck.
 *
 * The assertions run in module-level block scopes. No `describe`/`it`
 * because nothing executes at runtime; readable scoping comes from the
 * `// === group name ===` comments alone.
 */

import { z } from 'zod';

import type {
  EmptyOperationsManifestError,
  OperationsOf,
  RouteWithOpId,
  SchemesOf
} from '../src/index.ts';

import { TypedRegistry } from '../src/index.ts';

const okResponse = {
  200: {
    description: 'ok',
    content: { 'application/json': { schema: z.object({}) } }
  }
} as const;

// === registerPath returns a registry typed with the new operationId =========

// After a chained registerPath call, the returned registry's ops include
// the new key with its literal operationId — no annotation needed on the
// containing variable.
{
  const r = new TypedRegistry().registerPath({
    operationId: 'getThing',
    method: 'get',
    path: '/things/{id}',
    responses: okResponse
  });

  // `r.ops.getThing` is the registered route, not `never`.
  const op: RouteWithOpId = r.ops.getThing;
  void op;

  // @ts-expect-error 'getOther' was not registered, so the key does not exist on `ops`
  const missing: RouteWithOpId = r.ops.getOther;
  void missing;
}

// === <const O> preserves literal types ======================================

// operationId is preserved as the literal type, not widened to string.
{
  const r = new TypedRegistry().registerPath({
    operationId: 'getMessage',
    method: 'get',
    path: '/messages/{id}',
    responses: okResponse
  });

  const op = r.ops.getMessage;

  // @ts-expect-error 'somethingElse' is not assignable to the literal 'getMessage'
  const wrong: 'somethingElse' = op.operationId;
  void wrong;
}

// === Chained registerPath calls accumulate keys =============================

{
  const r = new TypedRegistry()
    .registerPath({ operationId: 'a', method: 'get', path: '/a', responses: okResponse })
    .registerPath({ operationId: 'b', method: 'post', path: '/b', responses: okResponse });

  const a: RouteWithOpId = r.ops.a;
  const b: RouteWithOpId = r.ops.b;
  void a;
  void b;

  // @ts-expect-error 'c' was never registered
  const c: RouteWithOpId = r.ops.c;
  void c;
}

// === The narrow flows out through a function's inferred return type =========

// No `: TypedRegistry` annotation. No function-wrapper precondition. The
// chain's narrow is the function's inferred return type. An importer of
// `buildRegistry` reading `ReturnType<typeof buildRegistry>['ops']` sees
// every registered key.
function buildRegistry() {
  return new TypedRegistry()
    .registerPath({ operationId: 'a', method: 'get', path: '/a', responses: okResponse })
    .registerPath({ operationId: 'b', method: 'post', path: '/b', responses: okResponse });
}

{
  const r = buildRegistry();
  const a: RouteWithOpId = r.ops.a;
  const b: RouteWithOpId = r.ops.b;
  void a;
  void b;

  // @ts-expect-error 'c' was never registered
  const c: RouteWithOpId = r.ops.c;
  void c;
}

// === .with(fn) runs a helper and intersects its return into this ============

// Helpers are generic over the parent's accumulators so they preserve
// whatever was registered before `.with(helper)` was called. The chain
// inside the helper's body is what carries the new operations into the
// inferred return.
function addRoutes<Ops extends Record<string, RouteWithOpId>, Schemes extends Record<string, true>>(
  reg: TypedRegistry<Ops, Schemes>
) {
  return reg
    .registerPath({ operationId: 'x', method: 'get', path: '/x', responses: okResponse })
    .registerPath({ operationId: 'y', method: 'get', path: '/y', responses: okResponse });
}

{
  const r = new TypedRegistry().with(addRoutes);

  const x: RouteWithOpId = r.ops.x;
  const y: RouteWithOpId = r.ops.y;
  void x;
  void y;

  // @ts-expect-error 'z' was not registered by addRoutes
  const z: RouteWithOpId = r.ops.z;
  void z;
}

// === Composing multiple helpers preserves the union of their narrows ========

function addCore<Ops extends Record<string, RouteWithOpId>, Schemes extends Record<string, true>>(
  reg: TypedRegistry<Ops, Schemes>
) {
  return reg.registerPath({
    operationId: 'core',
    method: 'get',
    path: '/core',
    responses: okResponse
  });
}

function addExtra<Ops extends Record<string, RouteWithOpId>, Schemes extends Record<string, true>>(
  reg: TypedRegistry<Ops, Schemes>
) {
  return reg.registerPath({
    operationId: 'extra',
    method: 'get',
    path: '/extra',
    responses: okResponse
  });
}

{
  const r = new TypedRegistry().with(addCore).with(addExtra);

  // Both ops accumulated through the chain.
  const core: RouteWithOpId = r.ops.core;
  const extra: RouteWithOpId = r.ops.extra;
  void core;
  void extra;
}

// === A misbehaving helper that drops the parent narrow can't shrink Ops =====

// `.with` returns `this & R`. If a helper ignores its argument and
// constructs a fresh registry, the parent's existing registrations
// survive via the intersection.
function dropsParent(_reg: TypedRegistry<Record<string, RouteWithOpId>>) {
  return new TypedRegistry().registerPath({
    operationId: 'fromHelper',
    method: 'get',
    path: '/fromHelper',
    responses: okResponse
  });
}

{
  const r = new TypedRegistry()
    .registerPath({ operationId: 'first', method: 'get', path: '/first', responses: okResponse })
    .with(dropsParent);

  // `first` survives the misbehaving helper via `this & R` intersection.
  const first: RouteWithOpId = r.ops.first;
  void first;

  // The helper's contribution is also visible.
  const fromHelper: RouteWithOpId = r.ops.fromHelper;
  void fromHelper;
}

// === A helper that returns void is rejected at the constraint ===============

// `with<R extends TypedRegistry<any, any>>` rejects `R = void` — TS errors
// at the call site, surfacing the bug instead of leaving a silent empty
// manifest downstream.
{
  const r = new TypedRegistry();
  // @ts-expect-error helper returns void; `void` does not extend `TypedRegistry<any, any>`
  r.with(() => {
    /* forgot to return the chain */
  });
}

// === registerSecurityScheme narrows Schemes ================================

{
  const r = new TypedRegistry().registerSecurityScheme('apiKey', {
    type: 'apiKey',
    name: 'x-api-key',
    in: 'header'
  });

  // After the narrow, `r.schemes.apiKey` is `true`.
  const apiKey: true = r.schemes.apiKey;
  void apiKey;

  // @ts-expect-error 'bearer' was not registered
  const bearer: true = r.schemes.bearer;
  void bearer;
}

// === registerSecurityScheme narrows additively across multiple calls =======

{
  const r = new TypedRegistry()
    .registerSecurityScheme('apiKey', { type: 'apiKey', name: 'x-api-key', in: 'header' })
    .registerSecurityScheme('bearer', { type: 'http', scheme: 'bearer' });

  // Both names appear in `keyof schemes`.
  const apiKey: true = r.schemes.apiKey;
  const bearer: true = r.schemes.bearer;
  void apiKey;
  void bearer;
}

// === registerComponent does NOT narrow for non-securitySchemes types =======

{
  const r = new TypedRegistry().registerComponent('schemas', 'Whatever', { type: 'object' });

  // `r.schemes` stays at `{}` — the literal 'Whatever' must NOT be a key.
  // @ts-expect-error registering a non-securitySchemes component must NOT add to Schemes
  const nope: true = r.schemes.Whatever;
  void nope;
}

// === Function-wrapped composition preserves Schemes narrowing ==============

function buildAuthRegistry() {
  return new TypedRegistry().registerSecurityScheme('apiKey', {
    type: 'apiKey',
    name: 'x-api-key',
    in: 'header'
  });
}

{
  const r = buildAuthRegistry();
  const apiKey: true = r.schemes.apiKey;
  void apiKey;
}

// === OperationsOf<F> returns the operations manifest from a builder ========

{
  type Ops = OperationsOf<typeof buildRegistry>;

  // Both keys are present.
  const a: RouteWithOpId = {} as Ops['a'];
  const b: RouteWithOpId = {} as Ops['b'];
  void a;
  void b;

  // @ts-expect-error 'c' was never registered, so the key does not exist on Ops
  const c: RouteWithOpId = {} as Ops['c'];
  void c;
}

// === SchemesOf<F> returns the schemes presence-map from a builder ==========

{
  type Schemes = SchemesOf<typeof buildAuthRegistry>;

  // Scheme name is a key.
  const apiKey: true = {} as Schemes['apiKey'];
  void apiKey;

  // @ts-expect-error 'bearer' was never registered
  const bearer: true = {} as Schemes['bearer'];
  void bearer;
}

// === OperationsOf<F> brands the empty case ================================

// If a builder forgets to chain at all (returns the bare construction),
// the operations manifest is `{}`. `OperationsOf` resolves to the brand
// string instead of `{}`, surfacing the bug at the consumer site.
function emptyBuilder() {
  return new TypedRegistry();
}
void emptyBuilder; // referenced as a value so lint sees it used; only typeof matters here

{
  type Ops = OperationsOf<typeof emptyBuilder>;

  // The brand is the literal error string. Assigning it to anything else
  // is a type error, which is the surface a downstream consumer hits when
  // they try to iterate keys or wire handlers off an empty manifest.
  const branded: EmptyOperationsManifestError = {} as Ops;
  void branded;

  // @ts-expect-error the brand is a string, not a Record — common consumer
  // shapes (e.g. `keyof Ops` for handler wiring) fail noisily against it.
  const asManifest: Record<string, RouteWithOpId> = {} as Ops;
  void asManifest;
}

// === A discarded-return-value bug surfaces as the empty brand =============

// The chainable API's main silent failure mode: every registration's
// return is dropped, the registry stays at its initial empty type, and
// downstream `OperationsOf<typeof buildRegistry>` resolves to the brand.
function discardedReturns() {
  const r = new TypedRegistry();
  r.registerPath({ operationId: 'a', method: 'get', path: '/a', responses: okResponse });
  r.registerPath({ operationId: 'b', method: 'get', path: '/b', responses: okResponse });
  return r;
}
void discardedReturns;

{
  type Ops = OperationsOf<typeof discardedReturns>;

  // The brand fires — Ops is the error string, not `{ a: ..., b: ... }`.
  const branded: EmptyOperationsManifestError = {} as Ops;
  void branded;
}

// === A populated builder is NOT branded ===================================

{
  type Ops = OperationsOf<typeof buildRegistry>;

  // @ts-expect-error a populated manifest is NOT the brand string
  const branded: EmptyOperationsManifestError = {} as Ops;
  void branded;
}
