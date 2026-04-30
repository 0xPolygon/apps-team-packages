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
      const r: TypedRegistry = new TypedRegistry();
      r.registerPath({
        operationId: 'getThing',
        method: 'get',
        path: '/things/{id}',
        responses: okResponse
      });
      expect(registeredOperationIds(r)).toEqual(['getThing']);
    });

    it('accepts multiple registerPath calls and accumulates definitions', () => {
      const r: TypedRegistry = new TypedRegistry();
      r.registerPath({
        operationId: 'a',
        method: 'get',
        path: '/a',
        responses: okResponse
      });
      r.registerPath({
        operationId: 'b',
        method: 'post',
        path: '/b',
        responses: okResponse
      });
      expect(registeredOperationIds(r)).toEqual(['a', 'b']);
    });
  });

  describe('extend', () => {
    it('runs the helper against the receiver and accumulates routes', () => {
      const r: TypedRegistry = new TypedRegistry();
      r.extend((reg: TypedRegistry) => {
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
      });
      expect(registeredOperationIds(r)).toEqual(['x', 'y']);
    });

    it('composes multiple helpers into the same registry', () => {
      const r: TypedRegistry = new TypedRegistry();
      const addA = (reg: TypedRegistry) => {
        reg.registerPath({
          operationId: 'a',
          method: 'get',
          path: '/a',
          responses: okResponse
        });
        return reg;
      };
      const addB = (reg: TypedRegistry) => {
        reg.registerPath({
          operationId: 'b',
          method: 'get',
          path: '/b',
          responses: okResponse
        });
        return reg;
      };
      r.extend(addA);
      r.extend(addB);
      expect(registeredOperationIds(r)).toEqual(['a', 'b']);
    });
  });

  describe('forwarded methods', () => {
    it('register forwards to inner.register and registers the component', () => {
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

    it('registerComponent forwards generic OpenAPI components', () => {
      const r = new TypedRegistry();
      r.registerComponent('schemas', 'Whatever', { type: 'object' });
      expect(definitionsOfType(r, 'component')).toHaveLength(1);
    });

    it('registerSecurityScheme registers the scheme via the inner registry', () => {
      // Explicit `: TypedRegistry` annotation required for the
      // `asserts this is X` narrowing — same TS2775 rule that gates
      // `registerPath`. The narrow itself is covered by the type tests
      // in typedRegistry.test-d.ts; here we just confirm the runtime
      // call accumulates the scheme into `definitions` for downstream
      // OpenAPI generation.
      const r: TypedRegistry = new TypedRegistry();
      r.registerSecurityScheme('apiKey', {
        type: 'apiKey',
        name: 'x-api-key',
        in: 'header'
      });
      r.registerSecurityScheme('bearer', { type: 'http', scheme: 'bearer' });
      expect(definitionsOfType(r, 'component')).toHaveLength(2);
    });

    it('registerWebhook forwards to inner.registerWebhook', () => {
      const r = new TypedRegistry();
      r.registerWebhook({
        method: 'post',
        path: '/hook',
        responses: okResponse
      });
      expect(definitionsOfType(r, 'webhook')).toHaveLength(1);
    });
  });
});
