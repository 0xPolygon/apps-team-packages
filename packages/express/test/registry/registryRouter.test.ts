/**
 * Setup-time guard tests for `createRegistryRouter`. End-to-end behaviour
 * (request validation, response encoding, multi-status routing, error paths)
 * is covered by `integration.test.ts`; this file owns the construction-time
 * checks that fire from `toExpress()` — both compile-time exhaustiveness
 * (covered by type tests in `auth.test-d.ts` and friends) and the runtime
 * defence-in-depth that catches well-typed code that's been bypassed via
 * casts.
 */

import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
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
    const registry: TypedRegistry = new TypedRegistry();
    registry.registerPath({
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
    const registry: TypedRegistry = new TypedRegistry();
    // The asteasolutions `RouteConfig` types `request.headers` as
    // `RouteParameter | ZodType[]`. Our `TypedRegistry.registerPath` only
    // exposes the object form in its public types — the array form is
    // unsupported by design — so cast the headers field through `never`
    // to construct a config we deliberately want the validator to reject.
    registry.registerPath({
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
});
