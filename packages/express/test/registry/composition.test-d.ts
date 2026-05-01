/**
 * Type-level assertions for partial-implement composition. End-to-end
 * runtime behaviour is covered by `composition.integration.test.ts`; this
 * file pins the compile-time guarantees:
 *
 *   - `.implement(partialBag)` accepts subsets of `HandlerMap<Ops>`.
 *   - Surplus keys (not in `Ops`) are TS errors at the implement site.
 *   - `.toExpress()` is callable only when every operation has been bound;
 *     a missing operation surfaces as a `MissingHandlersError` diagnostic.
 *   - Per-domain bags written with `satisfies Partial<HandlerMapFor<F, AuthMap>>`
 *     type each handler against its operation and reject unknown
 *     operationIds at the definition site.
 */

import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import { TypedRegistry } from '@polygonlabs/openapi-registry';

import type { HandlerMapFor } from '../../src/registry/index.ts';

import { createRegistryRouter } from '../../src/registry/index.ts';

extendZodWithOpenApi(z);

const HelloResponse = z.object({ message: z.string() });
const okResponse = {
  200: { description: 'ok', content: { 'application/json': { schema: HelloResponse } } }
} as const;

const buildRegistry = () =>
  new TypedRegistry()
    .registerPath({
      operationId: 'getStatus',
      method: 'get',
      path: '/status',
      responses: okResponse
    })
    .registerPath({
      operationId: 'getHealth',
      method: 'get',
      path: '/health',
      responses: okResponse
    })
    .registerPath({
      operationId: 'rebalance',
      method: 'post',
      path: '/management/rebalance',
      responses: okResponse
    });

const registry = buildRegistry();

// === .implement() accepts partial bags =====================================

{
  const router = createRegistryRouter({ registry }).implement({
    getStatus: (_req, res) => {
      res.json({ message: 'ok' });
    }
  });
  void router;
}

// === Multiple .implement() calls accumulate ================================

{
  const router = createRegistryRouter({ registry })
    .implement({
      getStatus: (_req, res) => {
        res.json({ message: 'ok' });
      }
    })
    .implement({
      getHealth: (_req, res) => {
        res.json({ message: 'healthy' });
      }
    })
    .implement({
      rebalance: (_req, res) => {
        res.json({ message: 'rebalanced' });
      }
    });

  // All three operations are bound — toExpress is callable.
  router.toExpress();
}

// === Surplus keys at the implement site fail ===============================

{
  createRegistryRouter({ registry }).implement({
    getStatus: (_req, res) => {
      res.json({ message: 'ok' });
    },
    // @ts-expect-error 'unknownOp' is not a registered operationId
    unknownOp: (_req, res) => {
      res.json({ message: 'huh' });
    }
  });
}

// === toExpress fails when an operation is unimplemented ====================

{
  const router = createRegistryRouter({ registry }).implement({
    getStatus: (_req, res) => {
      res.json({ message: 'ok' });
    }
    // getHealth and rebalance not bound
  });

  // @ts-expect-error toExpress must surface the missing-handlers diagnostic
  router.toExpress();
}

// === toExpress fails when nothing has been implemented =====================

{
  const router = createRegistryRouter({ registry });

  // @ts-expect-error no .implement() at all → all three ops are missing
  router.toExpress();
}

// === satisfies Partial<HandlerMapFor<F>> for per-domain bags ===============

// Define a partial bag in module-style (e.g. exported from
// `routes/status.ts`) and confirm it accepts subset bags. Each handler's
// `req` / `res` narrows to the operation's typed view via the
// `Partial<HandlerMapFor<typeof buildRegistry>>` constraint; surplus keys
// are TS errors at the definition site.
const statusHandlers = {
  getStatus: (_req, res) => {
    res.json({ message: 'ok' });
  }
} satisfies Partial<HandlerMapFor<typeof buildRegistry>>;

const managementHandlers = {
  rebalance: (_req, res) => {
    res.json({ message: 'rebalanced' });
  }
} satisfies Partial<HandlerMapFor<typeof buildRegistry>>;

// Composing module-defined bags via chained .implement() — the compose-site
// equivalent of importing handler bags from per-domain modules.
{
  const router = createRegistryRouter({ registry })
    .implement(statusHandlers)
    .implement(managementHandlers);

  // getHealth is missing — toExpress fails with the diagnostic.
  // @ts-expect-error missing handler for getHealth
  router.toExpress();

  // Add the missing handler and toExpress passes.
  router
    .implement({
      getHealth: (_req, res) => {
        res.json({ message: 'healthy' });
      }
    })
    .toExpress();
}

// satisfies-form rejects unknown operationIds at the definition site.
{
  const _bag = {
    getStatus: (_req, res) => {
      res.json({ message: 'ok' });
    },
    // @ts-expect-error 'unknownOp' is not a registered operationId
    unknownOp: (_req, res) => {
      res.json({ message: 'huh' });
    }
  } satisfies Partial<HandlerMapFor<typeof buildRegistry>>;
  void _bag;
}
