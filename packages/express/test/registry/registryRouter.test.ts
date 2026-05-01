/**
 * Setup-time guard tests for `createRegistryRouter`. End-to-end behaviour
 * (request validation, response encoding, multi-status routing, error paths)
 * is covered by `integration.test.ts`; this file owns the construction-time
 * checks that fire from `toExpress()` — both compile-time exhaustiveness
 * (covered by type tests in `auth.test-d.ts` and friends) and the runtime
 * defence-in-depth that catches well-typed code that's been bypassed via
 * casts.
 */

import type { RouteConfig } from '@asteasolutions/zod-to-openapi';

import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import express, { json } from 'express';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TypedRegistry } from '@polygonlabs/openapi-registry';

import { createRegistryRouter } from '../../src/registry/index.ts';

extendZodWithOpenApi(z);

const HelloResponse = z.object({ message: z.string() });
const okResponse = {
  200: { description: 'Hello', content: { 'application/json': { schema: HelloResponse } } }
} as const;

describe('createRegistryRouter', () => {
  it('throws at toExpress runtime when an operation has no bound handler', () => {
    // Compile-time: `.toExpress()`'s `this:` type guard rejects this with a
    // clear "Missing handlers" diagnostic. The cast bypasses the guard so
    // we can exercise the runtime fallback that fires from inside the
    // operation-mounting loop. Production code never reaches this branch.
    const registry = new TypedRegistry().registerPath({
      operationId: 'getHello',
      method: 'get',
      path: '/hello',
      responses: okResponse
    });
    const router = createRegistryRouter({ registry });
    expect(() => (router.toExpress as () => unknown)()).toThrow(/no handler for operation/);
  });

  it('throws at toExpress when an operation declares array-form request.headers', () => {
    // Array-form headers (`request.headers: ZodType[]`) is asteasolutions's
    // "registered parameter" reuse pattern; the per-element header name lives
    // in private `.openapi(...)` metadata. We do not support it — the object
    // form (`z.object({ 'x-foo': z.string() })`) is strictly more flexible
    // for runtime validation. The guard converts what would otherwise be a
    // silent skip (no validation, handler sees raw req.headers) into a loud
    // failure at server startup.
    // The asteasolutions `RouteConfig` types `request.headers` as
    // `RouteParameter | ZodType[]`. Our `TypedRegistry.registerPath` only
    // exposes the object form in its public types — the array form is
    // unsupported by design — so cast the headers field through `never`
    // to construct a config we deliberately want the validator to reject.
    const registry = new TypedRegistry().registerPath({
      operationId: 'arrayHeadersOp',
      method: 'get',
      path: '/array-headers',
      request: {
        headers: [z.string().openapi({ param: { name: 'x-foo', in: 'header' } })] as never
      },
      responses: okResponse
    });
    const router = createRegistryRouter({ registry });
    // The cast on .implement() mirrors the cast on the headers field: the
    // route was constructed with a deliberately invalid headers shape that
    // doesn't typecheck cleanly, and we just need a handler bag to exercise
    // toExpress. The cast on toExpress bypasses the exhaustiveness gate so
    // we reach the array-headers throw inside the validator.
    (router.implement as (handlers: unknown) => unknown)({
      arrayHeadersOp: (_req: unknown, res: { json: (body: unknown) => unknown }) => {
        res.json({ message: 'ok' });
      }
    });
    expect(() => (router.toExpress as () => unknown)()).toThrow(/array-form request\.headers/);
  });

  // Defends against the regression that fell out of asteasolutions's `Method`
  // union covering more verbs (`head`, `options`, `trace`) than the
  // mounting switch knew about. Before the fix the switch had no
  // matching case for these and no `default`, so the route silently
  // mounted nothing and returned 404 at request time. We register one
  // route per verb that the union supports and verify each is actually
  // reachable — supertest's verb methods cover all eight.
  it('mounts every method in asteasolutions Method union', async () => {
    const verbs = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const;

    let registry: TypedRegistry = new TypedRegistry();
    const handlers: Record<
      string,
      (_req: unknown, res: { json: (b: unknown) => unknown }) => void
    > = {};
    for (const verb of verbs) {
      const opId = `${verb}Hello`;
      // Imperative reassignment is the chainable-API equivalent of the
      // old discarded-return pattern — keeps the per-verb branch but
      // captures each chain return so the runtime registry stays in sync
      // with the type-level narrow.
      registry = registry.registerPath({
        operationId: opId,
        // The cast aligns the literal type with `RouteConfig['method']` —
        // `verbs` is a tuple of literals; without it TS widens to `string`.
        method: verb as RouteConfig['method'],
        path: `/${verb}`,
        responses: okResponse
      });
      handlers[opId] = (_req, res) => {
        res.json({ message: verb });
      };
    }

    const router = createRegistryRouter({ registry });
    // The cast bypasses the type-level handler-map narrowing; the runtime
    // bag covers every operationId so `.toExpress()` mounts cleanly.
    const expressRouter = (router.implement as (h: unknown) => { toExpress: () => express.Router })(
      handlers
    ).toExpress();

    const app = express();
    app.use(json());
    app.use(expressRouter);

    for (const verb of verbs) {
      const r = await supertest(app)[verb](`/${verb}`);
      // HEAD must not return a body (Node strips it); the others should
      // round-trip the verb name through the handler. A 404 here means
      // the switch silently dropped the route.
      expect(r.status, `${verb} /${verb} should not 404`).not.toBe(404);
      if (verb !== 'head') {
        expect(r.body).toEqual({ message: verb });
      }
    }
  });
});
