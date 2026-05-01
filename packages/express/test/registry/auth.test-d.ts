/**
 * Type-level assertions for the registry-driven router's auth typing.
 *
 * Vitest's runtime test runner ignores `.test-d.ts`; the file's signal comes
 * from `tsc --noEmit` (CI runs it via the package's `typecheck` script).
 * Each `@ts-expect-error` directive succeeds when the line below it IS a
 * type error and FAILS when it isn't.
 */

import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import { TypedRegistry } from '@polygonlabs/openapi-registry';

import { createRegistryRouter } from '../../src/registry/index.ts';

extendZodWithOpenApi(z);

const HelloResponse = z.object({ message: z.string() });
const okResponse = {
  200: { description: 'ok', content: { 'application/json': { schema: HelloResponse } } }
} as const;

// === Build a registry with two security schemes and three operations =======
//
// One operation has no security (public), one requires apiKey, one requires
// both apiKey AND bearer. The auth handlers' return types are deliberately
// distinct so we can prove flow-through to per-operation `req.auth`.

const buildRegistry = () =>
  new TypedRegistry()
    .registerSecurityScheme('apiKey', {
      type: 'apiKey',
      name: 'x-api-key',
      in: 'header'
    })
    .registerSecurityScheme('bearer', { type: 'http', scheme: 'bearer' })
    .registerPath({
      operationId: 'publicOp',
      method: 'get',
      path: '/public',
      responses: okResponse
    })
    .registerPath({
      operationId: 'protectedOp',
      method: 'get',
      path: '/protected',
      security: [{ apiKey: [] }],
      responses: okResponse
    })
    .registerPath({
      operationId: 'doubleAuthOp',
      method: 'get',
      path: '/double',
      security: [{ apiKey: [], bearer: [] }],
      responses: okResponse
    });

const registry = buildRegistry();

// === .auth() exhaustiveness =================================================

// Both schemes present — accepted.
{
  const router = createRegistryRouter({ registry }).auth({
    apiKey: async () => ({ tenantId: 't' }),
    bearer: async () => ({ userId: 'u' })
  });
  void router;
}

// Missing handler — TS error (apiKey present, bearer missing).
{
  const router = createRegistryRouter({ registry }).auth(
    // @ts-expect-error missing handler for 'bearer'
    {
      apiKey: async () => ({ tenantId: 't' })
    }
  );
  void router;
}

// Surplus handler — TS error (registry doesn't have 'oauth' scheme).
{
  const router = createRegistryRouter({ registry }).auth({
    apiKey: async () => ({ tenantId: 't' }),
    bearer: async () => ({ userId: 'u' }),
    // @ts-expect-error 'oauth' is not a registered scheme name
    oauth: async () => ({})
  });
  void router;
}

// Wrong handler signature (not a function) — TS error.
{
  const router = createRegistryRouter({ registry }).auth({
    apiKey: async () => ({ tenantId: 't' }),
    // @ts-expect-error handler must be a function (AuthHandler), not a string
    bearer: 'oops'
  });
  void router;
}

// === req.auth flow from inline auth handler return types ===================
//
// Consumers don't write the AuthMap type by hand — `.auth({...})` infers it
// from the inline handlers and threads it into `.implement(...)` so each
// op handler sees `req.auth[schemeName]` as the matching auth handler's
// awaited return type.

{
  const router = createRegistryRouter({ registry }).auth({
    apiKey: async () => ({ tenantId: 'inline-t' }),
    bearer: async () => ({ scope: 'admin' as const })
  });

  router.implement({
    publicOp: (req, res) => {
      // Public op — req.auth must NOT exist (no `security` declared).
      // @ts-expect-error req.auth must not exist on operations without `security`
      void req.auth;
      res.json({ message: 'public' });
    },
    protectedOp: (req, res) => {
      // tenantId is string from the inline handler.
      const t: string = req.auth.apiKey.tenantId;

      // @ts-expect-error apiKey principal is { tenantId: string }, no userId field
      const wrongField: string = req.auth.apiKey.userId;
      void wrongField;

      // @ts-expect-error 'bearer' is not in this op's security set
      const bearerNope = req.auth.bearer;
      void bearerNope;

      res.json({ message: t });
    },
    doubleAuthOp: (req, res) => {
      // Both principals present; bearer carries `scope: 'admin'` (literal).
      const tenantId: string = req.auth.apiKey.tenantId;
      const scope: 'admin' = req.auth.bearer.scope;
      res.json({ message: `${tenantId}:${scope}` });
    }
  });
}
