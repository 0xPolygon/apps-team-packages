/**
 * Type-level assertions for `TypedRegistry`.
 *
 * Vitest's runtime test runner ignores `.test-d.ts`; the file's signal comes
 * from `tsc --noEmit` (run by `pnpm run typecheck`, which CI gates on). Each
 * `@ts-expect-error` directive succeeds when the line below it IS a type
 * error and FAILS when it isn't, so a regression that flips an assertion
 * either way fails the typecheck.
 *
 * The assertions run in module-level block scopes. No `describe`/`it` because
 * nothing executes at runtime; readable scoping comes from the `// === group
 * name ===` comments alone.
 */

import { z } from 'zod';

import type { RouteWithOpId } from '../src/index.ts';

import { TypedRegistry } from '../src/index.ts';

const okResponse = {
  200: {
    description: 'ok',
    content: { 'application/json': { schema: z.object({}) } }
  }
} as const;

// === registerPath narrows the receiver's Ops ================================

// After a single registerPath call, the registry's ops include the new key
// with its literal operationId.
{
  const r: TypedRegistry = new TypedRegistry();
  r.registerPath({
    operationId: 'getThing',
    method: 'get',
    path: '/things/{id}',
    responses: okResponse
  });

  // The narrow makes `ops.getThing` the registered route, not `never`.
  const op: RouteWithOpId = r.ops.getThing;
  void op;

  // @ts-expect-error 'getOther' was not registered, so the key does not exist on `ops`
  const missing: RouteWithOpId = r.ops.getOther;
  void missing;
}

// === <const O> preserves literal types ======================================

// operationId is preserved as the literal type, not widened to string.
{
  const r: TypedRegistry = new TypedRegistry();
  r.registerPath({
    operationId: 'getMessage',
    method: 'get',
    path: '/messages/{id}',
    responses: okResponse
  });

  // The literal survives — `op.operationId` is the literal type
  // 'getMessage', so a different literal is rejected.
  const op = r.ops.getMessage;

  // @ts-expect-error 'somethingElse' is not assignable to the literal 'getMessage'
  const wrong: 'somethingElse' = op.operationId;
  void wrong;
}

// === Cross-module narrow propagation via function wrapper ===================

// Top-level `export const registry = …; registry.registerPath(…)` would lose
// the narrow at the export boundary. Wrapping in a function preserves it via
// the inferred return type.
function buildRegistry() {
  const registry: TypedRegistry = new TypedRegistry();
  registry.registerPath({
    operationId: 'a',
    method: 'get',
    path: '/a',
    responses: okResponse
  });
  registry.registerPath({
    operationId: 'b',
    method: 'post',
    path: '/b',
    responses: okResponse
  });
  return registry;
}

type Built = ReturnType<typeof buildRegistry>;

// Both keys survived the function boundary.
{
  const r = buildRegistry();
  const a: Built['ops']['a'] = r.ops.a;
  const b: Built['ops']['b'] = r.ops.b;
  void a;
  void b;

  // @ts-expect-error 'c' was never registered
  const c: RouteWithOpId = r.ops.c;
  void c;
}

// === .extend(fn) narrows via asserts this is R ==============================

function addRoutes<Prev extends Record<string, RouteWithOpId>>(reg: TypedRegistry<Prev>) {
  reg.registerPath({
    operationId: 'x',
    method: 'get',
    path: '/x',
    responses: okResponse
  });
  reg.registerPath({
    operationId: 'y',
    method: 'get',
    path: '/y',
    responses: okResponse
  });
  return reg;
}

{
  const r: TypedRegistry = new TypedRegistry();
  r.extend(addRoutes);

  const x: RouteWithOpId = r.ops.x;
  const y: RouteWithOpId = r.ops.y;
  void x;
  void y;

  // @ts-expect-error 'z' was not registered by addRoutes
  const z: RouteWithOpId = r.ops.z;
  void z;
}

// === Composing multiple helpers preserves the union of their narrows ========

function addCore<Prev extends Record<string, RouteWithOpId>>(reg: TypedRegistry<Prev>) {
  reg.registerPath({
    operationId: 'core',
    method: 'get',
    path: '/core',
    responses: okResponse
  });
  return reg;
}

function addExtra<Prev extends Record<string, RouteWithOpId>>(reg: TypedRegistry<Prev>) {
  reg.registerPath({
    operationId: 'extra',
    method: 'get',
    path: '/extra',
    responses: okResponse
  });
  return reg;
}

{
  const r: TypedRegistry = new TypedRegistry();
  r.extend(addCore);
  r.extend(addExtra);

  // Both ops accumulated.
  const core: RouteWithOpId = r.ops.core;
  const extra: RouteWithOpId = r.ops.extra;
  void core;
  void extra;
}

// === A clobbering helper that returns a wider registry doesn't reduce Ops ===

// `asserts this is R` intersects R with the current `this`, so an
// underspecified return type can only ADD to the narrow, never remove from it.
function dropsType(reg: TypedRegistry<Record<string, RouteWithOpId>>) {
  reg.registerPath({
    operationId: 'kept',
    method: 'get',
    path: '/kept',
    responses: okResponse
  });
  return reg;
}

{
  const r: TypedRegistry = new TypedRegistry();
  r.registerPath({
    operationId: 'first',
    method: 'get',
    path: '/first',
    responses: okResponse
  });
  r.extend(dropsType);

  // `first` survives the wider extend return type.
  const first: RouteWithOpId = r.ops.first;
  void first;
}

// === registerSecurityScheme narrows Schemes ================================
//
// `Schemes` is a presence-map (`Record<string, true>`) keyed by scheme name —
// see the comment on the `schemes` field about TypeScript's `never`-default
// quirk. Read scheme names via `keyof Schemes & string`.

{
  const r: TypedRegistry = new TypedRegistry();
  r.registerSecurityScheme('apiKey', {
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
  const r: TypedRegistry = new TypedRegistry();
  r.registerSecurityScheme('apiKey', {
    type: 'apiKey',
    name: 'x-api-key',
    in: 'header'
  });
  r.registerSecurityScheme('bearer', { type: 'http', scheme: 'bearer' });

  // Both names appear in `keyof schemes`.
  const apiKey: true = r.schemes.apiKey;
  const bearer: true = r.schemes.bearer;
  void apiKey;
  void bearer;
}

// === registerComponent does NOT narrow for non-securitySchemes types ========

{
  const r: TypedRegistry = new TypedRegistry();
  // The plain `registerComponent` is for everything except securitySchemes
  // and produces no type-level effect on `Schemes`. Register a schema:
  r.registerComponent('schemas', 'Whatever', { type: 'object' });

  // `r.schemes` stays at `{}` — the literal 'Whatever' must NOT be a key.
  // @ts-expect-error registering a non-securitySchemes component must NOT add to Schemes
  const nope: true = r.schemes.Whatever;
  void nope;
}

// === Function-wrapped composition preserves Schemes narrowing ==============

function buildAuthRegistry() {
  const r: TypedRegistry = new TypedRegistry();
  r.registerSecurityScheme('apiKey', {
    type: 'apiKey',
    name: 'x-api-key',
    in: 'header'
  });
  return r;
}

{
  const r = buildAuthRegistry();
  // The narrow survived the function boundary (per the same precondition
  // that makes `Ops` survive).
  const apiKey: true = r.schemes.apiKey;
  void apiKey;
}
