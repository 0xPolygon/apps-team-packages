/**
 * End-to-end integration tests for partial-implement composition. Spins up
 * a real Express app via `createRegistryRouter().implement(...).implement(...).toExpress()`
 * to confirm:
 *
 *   - Multiple `.implement()` calls accumulate handlers (Object.assign-merge
 *     at runtime); the resulting router serves all of them.
 *   - Module-style handler bags (typed via `satisfies Partial<HandlerMapFor<F>>`)
 *     compose with inline bags at the wiring site.
 *   - The exhaustiveness check is type-only: runtime serves whatever has
 *     been bound. Unbound operations would surface as a runtime
 *     "no handler for operation" throw at toExpress time, but with
 *     well-typed code that path is unreachable.
 */

import type { Express } from 'express';

import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import express, { json } from 'express';
import supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TypedRegistry } from '@polygonlabs/openapi-registry';

import type { HandlerMapFor } from '../../src/registry/index.ts';

import { setupLogger } from '../../src/context.ts';
import { createErrorHandler } from '../../src/errors.ts';
import { createRegistryRouter } from '../../src/registry/index.ts';
import { makeCaptureLogger } from '../helpers/captureLogger.ts';

extendZodWithOpenApi(z);

// === Schemas ===============================================================

const HelloResponse = z.object({ message: z.string() });

// === Registry ==============================================================

const buildRegistry = () =>
  new TypedRegistry()
    .registerPath({
      operationId: 'getStatus',
      method: 'get',
      path: '/status',
      responses: {
        200: { description: 'ok', content: { 'application/json': { schema: HelloResponse } } }
      }
    })
    .registerPath({
      operationId: 'getHealth',
      method: 'get',
      path: '/health',
      responses: {
        200: { description: 'ok', content: { 'application/json': { schema: HelloResponse } } }
      }
    })
    .registerPath({
      operationId: 'rebalance',
      method: 'post',
      path: '/management/rebalance',
      responses: {
        200: { description: 'ok', content: { 'application/json': { schema: HelloResponse } } }
      }
    });

// === Module-style handler bags =============================================
//
// These are the real-world shape — handler bags defined in per-domain
// modules (status.ts, management.ts) and composed at the wiring site.
// `satisfies Partial<HandlerMapFor<typeof buildRegistry>>` types each
// handler against its operation; surplus keys fail at the definition site.

const statusHandlers = {
  getStatus: (_req, res) => {
    res.json({ message: 'status-ok' });
  }
} satisfies Partial<HandlerMapFor<typeof buildRegistry>>;

const managementHandlers = {
  rebalance: (_req, res) => {
    res.json({ message: 'rebalanced' });
  }
} satisfies Partial<HandlerMapFor<typeof buildRegistry>>;

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
    app.use(json());
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
