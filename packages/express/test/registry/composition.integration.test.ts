/**
 * End-to-end integration tests for partial-implement composition. Spins up
 * a real Express app via `createRegistryRouter().implement(...).implement(...).toExpress()`
 * to confirm:
 *
 *   - Multiple `.implement()` calls accumulate handlers (Object.assign-merge
 *     at runtime); the resulting router serves all of them.
 *   - Module-style handler bags (typed via `defineHandlers`) compose with
 *     inline bags at the wiring site.
 *   - The exhaustiveness check is type-only: runtime serves whatever has
 *     been bound. Unbound operations would surface as a runtime
 *     "no handler for operation" throw at toExpress time, but with
 *     well-typed code that path is unreachable.
 */

import type { Express } from 'express';

import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import express from 'express';
import supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TypedRegistry } from '@polygonlabs/openapi-registry';

import { setupLogger } from '../../src/context.ts';
import { createErrorHandler } from '../../src/errors.ts';
import { createRegistryRouter, defineHandlers } from '../../src/registry/index.ts';
import { makeCaptureLogger } from '../helpers/captureLogger.ts';

extendZodWithOpenApi(z);

// === Schemas ===============================================================

const HelloResponse = z.object({ message: z.string() });

// === Registry ==============================================================

function buildRegistry() {
  const registry: TypedRegistry = new TypedRegistry();
  registry.registerPath({
    operationId: 'getStatus',
    method: 'get',
    path: '/status',
    responses: {
      200: { description: 'ok', content: { 'application/json': { schema: HelloResponse } } }
    }
  });
  registry.registerPath({
    operationId: 'getHealth',
    method: 'get',
    path: '/health',
    responses: {
      200: { description: 'ok', content: { 'application/json': { schema: HelloResponse } } }
    }
  });
  registry.registerPath({
    operationId: 'rebalance',
    method: 'post',
    path: '/management/rebalance',
    responses: {
      200: { description: 'ok', content: { 'application/json': { schema: HelloResponse } } }
    }
  });
  return registry;
}

type Operations =
  ReturnType<typeof buildRegistry> extends TypedRegistry<infer O, Record<string, true>> ? O : never;

// === Module-style handler bags =============================================
//
// These are the real-world shape from the user's question — handler bags
// defined in per-domain modules (status.ts, management.ts) and composed at
// the wiring site.

const statusHandlers = defineHandlers<Operations>()({
  getStatus: (_req, res) => {
    res.json({ message: 'status-ok' });
  }
});

const managementHandlers = defineHandlers<Operations>()({
  rebalance: (_req, res) => {
    res.json({ message: 'rebalanced' });
  }
});

// === Tests =================================================================

describe('partial-implement composition', () => {
  let app!: Express;

  beforeAll(async () => {
    const { logger } = await makeCaptureLogger();
    const registry = buildRegistry();

    // The wiring file: compose two module-defined bags + one inline bag.
    // The exhaustiveness check fires at .toExpress() — getStatus,
    // rebalance, getHealth are all bound here.
    const router = createRegistryRouter({ registry })
      .implement(statusHandlers)
      .implement(managementHandlers)
      .implement({
        getHealth: (_req, res) => {
          res.json({ message: 'healthy' });
        }
      });

    app = express();
    app.use(express.json());
    app.use(setupLogger(logger));
    app.use(router.toExpress());
    app.use(createErrorHandler());
  });

  it('serves operations bound via the first module bag', async () => {
    const r = await supertest(app).get('/status').expect(200);
    expect(r.body).toEqual({ message: 'status-ok' });
  });

  it('serves operations bound via the second module bag', async () => {
    const r = await supertest(app).post('/management/rebalance').expect(200);
    expect(r.body).toEqual({ message: 'rebalanced' });
  });

  it('serves operations bound via the inline bag at the wiring site', async () => {
    const r = await supertest(app).get('/health').expect(200);
    expect(r.body).toEqual({ message: 'healthy' });
  });
});
