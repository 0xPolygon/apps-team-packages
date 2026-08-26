import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { RouteWithOpId } from '../src/index.ts';

import { TypedRegistry } from '../src/index.ts';

// asteasolutions's `register` / `registerParameter` call `.openapi()` on the
// schema internally; the patch needs to be installed before either is used.
extendZodWithOpenApi(z);

const okResponse = {
  200: {
    description: 'ok',
    content: { 'application/json': { schema: z.object({}) } }
  }
} as const;

/** Returns the `operationId`s from every route registered on `r`. */
function registeredOperationIds(r: TypedRegistry): string[] {
  return r.definitions
    .filter(
      (d): d is { type: 'route'; route: RouteWithOpId } =>
        (d as { type?: unknown }).type === 'route'
    )
    .map((d) => d.route.operationId);
}

/** Returns definitions of the given `type` from `r.definitions`. */
function definitionsOfType(r: TypedRegistry, type: string): unknown[] {
  return r.definitions.filter((d) => (d as { type?: unknown }).type === type);
}

describe('TypedRegistry', () => {
  describe('registerPath', () => {
    it('forwards to the inner OpenAPIRegistry and exposes definitions', () => {
      const r = new TypedRegistry().registerPath({
        operationId: 'getThing',
        method: 'get',
        path: '/things/{id}',
        responses: okResponse
      });
      expect(registeredOperationIds(r)).toEqual(['getThing']);
    });

    it('returns the same underlying registry on each chain step', () => {
      // The chainable API mutates `inner` and returns the (now wider-typed)
      // same instance. Confirm the chain doesn't fork — definitions
      // accumulate on a single inner registry, not split across copies.
      const r0 = new TypedRegistry();
      const r1 = r0.registerPath({
        operationId: 'a',
        method: 'get',
        path: '/a',
        responses: okResponse
      });
      const r2 = r1.registerPath({
        operationId: 'b',
        method: 'post',
        path: '/b',
        responses: okResponse
      });

      expect(r0).toBe(r1);
      expect(r1).toBe(r2);
      expect(registeredOperationIds(r2)).toEqual(['a', 'b']);
    });

    it('chained calls accumulate definitions in chain order', () => {
      const r = new TypedRegistry()
        .registerPath({ operationId: 'a', method: 'get', path: '/a', responses: okResponse })
        .registerPath({ operationId: 'b', method: 'post', path: '/b', responses: okResponse })
        .registerPath({ operationId: 'c', method: 'get', path: '/c', responses: okResponse });

      expect(registeredOperationIds(r)).toEqual(['a', 'b', 'c']);
    });

    it('discarded chain returns still mutate the underlying registry', () => {
      // The runtime side effect happens regardless of whether the caller
      // captures the return — the type-level narrow is what gets dropped.
      // This test pins the documented behaviour: runtime is unchanged,
      // and the OperationsOf brand (covered in the type tests) is what
      // surfaces the bug at consumer sites. The eslint-disables scope to
      // exactly the lines that make this test what it is.
      const r = new TypedRegistry();
      // eslint-disable-next-line polygon/no-discarded-typed-registry-chain -- intentional: this is the failure-mode pin
      r.registerPath({ operationId: 'a', method: 'get', path: '/a', responses: okResponse });
      // eslint-disable-next-line polygon/no-discarded-typed-registry-chain -- intentional: this is the failure-mode pin
      r.registerPath({ operationId: 'b', method: 'get', path: '/b', responses: okResponse });

      expect(registeredOperationIds(r)).toEqual(['a', 'b']);
    });
  });

  describe('with', () => {
    it('runs the helper against the receiver and accumulates routes', () => {
      const r = new TypedRegistry().with((reg) =>
        reg
          .registerPath({ operationId: 'x', method: 'get', path: '/x', responses: okResponse })
          .registerPath({ operationId: 'y', method: 'get', path: '/y', responses: okResponse })
      );

      expect(registeredOperationIds(r)).toEqual(['x', 'y']);
    });

    it('composes multiple helpers into the same registry', () => {
      const addA = (reg: TypedRegistry) =>
        reg.registerPath({
          operationId: 'a',
          method: 'get',
          path: '/a',
          responses: okResponse
        });
      const addB = (reg: TypedRegistry) =>
        reg.registerPath({
          operationId: 'b',
          method: 'get',
          path: '/b',
          responses: okResponse
        });

      const r = new TypedRegistry().with(addA).with(addB);

      expect(registeredOperationIds(r)).toEqual(['a', 'b']);
    });

    it('returns the same instance — no fork even with a misbehaving helper', () => {
      // `.with` returns `this & R`. The runtime returns `this`; the
      // intersection is a type-level shape. A helper that constructs a
      // fresh registry and returns it from inside `.with` does not
      // replace the receiver — its registrations land on whatever
      // helper-internal registry was constructed and are lost.
      //
      // This is documented behaviour: helpers must chain off their
      // argument and return the chained value, not construct a new one.
      const r0 = new TypedRegistry().registerPath({
        operationId: 'parent',
        method: 'get',
        path: '/parent',
        responses: okResponse
      });

      const r1 = r0.with(() =>
        new TypedRegistry().registerPath({
          operationId: 'orphaned',
          method: 'get',
          path: '/orphaned',
          responses: okResponse
        })
      );

      // Same instance, only the parent's definition is visible.
      expect(r0).toBe(r1);
      expect(registeredOperationIds(r1)).toEqual(['parent']);
    });
  });

  describe('forwarded methods', () => {
    it('register forwards to inner.register and registers the schema', () => {
      const r = new TypedRegistry();
      const Schema = z.object({ x: z.string() });
      const out = r.register('Thing', Schema);
      // asteasolutions's register returns `schema.openapi(refId)`, which in
      // Zod v4 produces a clone via _def cloning — so `out !== Schema`. The
      // returned schema parses the same shape as the input.
      expect(out).toBeInstanceOf(z.ZodType);
      expect(definitionsOfType(r, 'schema')).toHaveLength(1);
    });

    it('registerParameter forwards to inner.registerParameter', () => {
      const r = new TypedRegistry();
      const Schema = z.string();
      const out = r.registerParameter('cursor', Schema);
      expect(out).toBeInstanceOf(z.ZodType);
      expect(definitionsOfType(r, 'parameter')).toHaveLength(1);
    });

    it('registerComponent forwards generic OpenAPI components and chains', () => {
      const r = new TypedRegistry()
        .registerComponent('schemas', 'A', { type: 'object' })
        .registerComponent('schemas', 'B', { type: 'object' });
      expect(definitionsOfType(r, 'component')).toHaveLength(2);
    });

    it('registerSecurityScheme registers the scheme and chains', () => {
      const r = new TypedRegistry()
        .registerSecurityScheme('apiKey', {
          type: 'apiKey',
          name: 'x-api-key',
          in: 'header'
        })
        .registerSecurityScheme('bearer', { type: 'http', scheme: 'bearer' });

      expect(definitionsOfType(r, 'component')).toHaveLength(2);
    });

    it('registerWebhook forwards to inner.registerWebhook and chains', () => {
      const r = new TypedRegistry().registerWebhook({
        method: 'post',
        path: '/hook',
        responses: okResponse
      });

      expect(definitionsOfType(r, 'webhook')).toHaveLength(1);
    });
  });

  describe('standardErrorResponses option', () => {
    /** Returns the registered route with the given operationId, or throws. */
    function routeOf(r: TypedRegistry, operationId: string): RouteWithOpId {
      const def = r.definitions.find(
        (d): d is { type: 'route'; route: RouteWithOpId } =>
          (d as { type?: unknown; route?: { operationId?: string } }).type === 'route' &&
          (d as { route: { operationId?: string } }).route.operationId === operationId
      );
      if (!def) throw new Error(`route ${operationId} not registered`);
      return def.route;
    }

    // Plain object (no `as const`): an explicit const assertion makes
    // `security` a readonly tuple, which RouteConfig's mutable
    // `SecurityRequirementObject[]` rejects. Inline literals at
    // registerPath call sites don't hit this — the `<const O>` type
    // parameter's inference is tempered by the RouteWithOpId constraint.
    const validatedSecuredRoute = {
      operationId: 'getGuarded',
      method: 'get' as const,
      path: '/guarded',
      request: { query: z.object({ q: z.string() }) },
      security: [{ ApiKeyAuth: [] }],
      responses: okResponse
    };

    it('omitted → injects 500/400/401 (original default behaviour)', () => {
      const r = new TypedRegistry().registerPath(validatedSecuredRoute);
      const responses = routeOf(r, 'getGuarded').responses;
      expect(Object.keys(responses).sort()).toEqual(['200', '400', '401', '500']);
    });

    it('false → injects nothing, even for validated + secured routes', () => {
      const r = new TypedRegistry({ standardErrorResponses: false }).registerPath(
        validatedSecuredRoute
      );
      const responses = routeOf(r, 'getGuarded').responses;
      expect(Object.keys(responses)).toEqual(['200']);
    });

    it('per-slot override swaps that schema and keeps defaults for the rest', () => {
      const GoStyleError = z.object({ error: z.string() });
      const r = new TypedRegistry({
        standardErrorResponses: { serverError: GoStyleError }
      }).registerPath(validatedSecuredRoute);
      const responses = routeOf(r, 'getGuarded').responses as Record<
        string,
        { content: { 'application/json': { schema: unknown } } }
      >;
      expect(responses[500]?.content['application/json'].schema).toBe(GoStyleError);
      // 400 keeps the default ValidationErrorResponseSchema — overriding
      // one slot must not disturb its siblings.
      expect(responses[400]?.content['application/json'].schema).not.toBe(GoStyleError);
      expect(responses[400]).toBeDefined();
      expect(responses[401]).toBeDefined();
    });

    it('user-declared response slots still win over configured overrides', () => {
      const GoStyleError = z.object({ error: z.string() });
      const RouteOwn500 = z.object({ mine: z.literal(true) });
      const r = new TypedRegistry({
        standardErrorResponses: { serverError: GoStyleError }
      }).registerPath({
        operationId: 'getOwn500',
        method: 'get',
        path: '/own',
        responses: {
          ...okResponse,
          500: {
            description: 'route-declared 500',
            content: { 'application/json': { schema: RouteOwn500 } }
          }
        }
      });
      const responses = routeOf(r, 'getOwn500').responses as Record<
        string,
        { content: { 'application/json': { schema: unknown } } }
      >;
      expect(responses[500]?.content['application/json'].schema).toBe(RouteOwn500);
    });
  });

  describe('coercing-schema audit', () => {
    const ok = { responses: okResponse } as const;

    it('throws on z.coerce in a query property, naming route and property', () => {
      expect(() =>
        new TypedRegistry().registerPath({
          operationId: 'getCoerced',
          method: 'get',
          path: '/coerced',
          request: { query: z.object({ networkId: z.coerce.number().int() }) },
          ...ok
        })
      ).toThrow(/getCoerced.*request\.query\.networkId.*z\.coerce/s);
    });

    it('throws even when the coercing schema is wrapped in optional/default', () => {
      expect(() =>
        new TypedRegistry().registerPath({
          operationId: 'getWrappedCoerce',
          method: 'get',
          path: '/wrapped',
          request: { params: z.object({ page: z.coerce.number().optional().default(1) }) },
          ...ok
        })
      ).toThrow(/getWrappedCoerce.*request\.params\.page/s);
    });

    it('accepts plain logical types and codecs (pipes are not coercion)', () => {
      const Int64ishCodec = z.codec(z.string().regex(/^\d+$/), z.bigint(), {
        decode: (s) => BigInt(s),
        encode: (b) => b.toString()
      });
      expect(() =>
        new TypedRegistry().registerPath({
          operationId: 'getClean',
          method: 'get',
          path: '/clean',
          request: {
            query: z.object({
              networkId: z.number().int(),
              amount: Int64ishCodec,
              from: z.string().optional()
            })
          },
          ...ok
        })
      ).not.toThrow();
    });

    it('does not inspect body schemas (JSON bodies are typed on the wire)', () => {
      expect(() =>
        new TypedRegistry().registerPath({
          operationId: 'postBody',
          method: 'post',
          path: '/body',
          request: {
            body: {
              content: {
                'application/json': { schema: z.object({ n: z.coerce.number() }) }
              }
            }
          },
          ...ok
        })
      ).not.toThrow();
    });
  });

  describe('end-to-end builder', () => {
    it('the recommended builder pattern produces the expected definitions', () => {
      const addCore = <Ops extends Record<string, RouteWithOpId>>(reg: TypedRegistry<Ops>) =>
        reg.registerPath({
          operationId: 'getHealthCheck',
          method: 'get',
          path: '/health-check',
          responses: okResponse
        });

      const addBlocks = <Ops extends Record<string, RouteWithOpId>>(reg: TypedRegistry<Ops>) =>
        reg
          .registerPath({
            operationId: 'getBlockNumber',
            method: 'get',
            path: '/block-number',
            responses: okResponse
          })
          .registerPath({
            operationId: 'getBlockMetadata',
            method: 'get',
            path: '/blocks/{id}',
            security: [{ ApiKeyAuth: [] }],
            responses: okResponse
          });

      const buildRegistry = () =>
        new TypedRegistry()
          .registerSecurityScheme('ApiKeyAuth', {
            type: 'apiKey',
            name: 'x-api-key',
            in: 'header'
          })
          .with(addCore)
          .with(addBlocks);

      const registry = buildRegistry();

      expect(registeredOperationIds(registry)).toEqual([
        'getHealthCheck',
        'getBlockNumber',
        'getBlockMetadata'
      ]);
      expect(definitionsOfType(registry, 'component')).toHaveLength(1);
    });
  });
});
