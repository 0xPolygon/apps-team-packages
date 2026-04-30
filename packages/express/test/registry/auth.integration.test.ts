/**
 * End-to-end integration tests for the registry-driven router's auth wiring.
 *
 * Spins up a real Express app via `createRegistryRouter().auth(...).implement(...).toExpress()`
 * — the production code path — to exercise:
 *
 *   - Compile-time exhaustiveness: `.auth(handlers)` covers every registered
 *     scheme (the type tests in `auth.test-d.ts` lock down the `@ts-expect-error`
 *     cases; this file tests the runtime behaviour assuming type-correct calls).
 *   - Runtime ordering: auth runs BEFORE request validation. A request that
 *     would fail body validation but lacks credentials returns 401, not 400 —
 *     the auth handler short-circuits before any body parsing happens.
 *   - Principal flow: the auth handler's return value lands on `req.auth[scheme]`
 *     for the route handler to read.
 *   - Failure modes: NotAuthenticated → 401, plain `Error` thrown by an auth
 *     handler is wrapped to NotAuthenticated → 401 (not leaked as 500).
 *   - Multi-scheme AND: an operation declaring two schemes runs both handlers
 *     and merges principals.
 *   - Setup-time guard: OR-style security throws at `toExpress()`.
 */

import type { Express } from 'express';

import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import express from 'express';
import supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TypedRegistry } from '@polygonlabs/openapi-registry';
import { Forbidden, NotAuthenticated } from '@polygonlabs/verror';

import type { HandlerMap } from '../../src/registry/index.ts';

import { setupLogger } from '../../src/context.ts';
import { createErrorHandler } from '../../src/errors.ts';
import { createRegistryRouter } from '../../src/registry/index.ts';
import { makeCaptureLogger } from '../helpers/captureLogger.ts';

extendZodWithOpenApi(z);

// === Schemas ===============================================================

const HelloResponse = z.object({ message: z.string() });
const Tenant = z.object({ tenantId: z.string() });

// === Registry ==============================================================

function buildAuthRegistry() {
  const registry: TypedRegistry = new TypedRegistry();

  registry.registerSecurityScheme('apiKey', {
    type: 'apiKey',
    name: 'x-api-key',
    in: 'header'
  });
  registry.registerSecurityScheme('bearer', { type: 'http', scheme: 'bearer' });

  // Public route — no `security`, no auth required.
  registry.registerPath({
    operationId: 'publicHello',
    method: 'get',
    path: '/public/hello',
    responses: {
      200: { description: 'ok', content: { 'application/json': { schema: HelloResponse } } }
    }
  });

  // Protected route — apiKey required. Body validation behind auth so we
  // can prove auth runs first.
  registry.registerPath({
    operationId: 'protectedTenant',
    method: 'post',
    path: '/protected/tenant',
    security: [{ apiKey: [] }],
    request: {
      body: {
        content: {
          'application/json': { schema: z.object({ note: z.string().min(1) }) }
        }
      }
    },
    responses: {
      200: { description: 'ok', content: { 'application/json': { schema: Tenant } } }
    }
  });

  // Multi-scheme AND — both apiKey and bearer must succeed.
  registry.registerPath({
    operationId: 'doubleAuth',
    method: 'get',
    path: '/protected/double',
    security: [{ apiKey: [], bearer: [] }],
    responses: {
      200: { description: 'ok', content: { 'application/json': { schema: HelloResponse } } }
    }
  });

  // Auth handler that throws a non-HTTP plain Error.
  registry.registerPath({
    operationId: 'apiKeyButBuggyHandler',
    method: 'get',
    path: '/protected/buggy',
    security: [{ apiKey: [] }],
    responses: {
      200: { description: 'ok', content: { 'application/json': { schema: HelloResponse } } }
    }
  });

  // Auth handler that throws Forbidden.
  registry.registerPath({
    operationId: 'forbiddenScheme',
    method: 'get',
    path: '/protected/forbidden',
    security: [{ bearer: [] }],
    responses: {
      200: { description: 'ok', content: { 'application/json': { schema: HelloResponse } } }
    }
  });

  return registry;
}

type Operations =
  ReturnType<typeof buildAuthRegistry> extends TypedRegistry<infer O, Record<string, true>>
    ? O
    : never;

// === Auth handlers =========================================================

const authHandlers = {
  apiKey: async (req: express.Request) => {
    // Path-based dispatch is purely a test convenience: real consumers
    // don't branch on req.path inside auth. We need different handlers
    // for `protectedTenant` (success), `apiKeyButBuggyHandler` (throws
    // plain Error), and `doubleAuth` (success).
    const key = req.get('x-api-key');
    if (req.path === '/protected/buggy') {
      throw new Error('database connection failed');
    }
    if (key !== 'good-key') {
      throw new NotAuthenticated('invalid api key');
    }
    return { tenantId: 'tenant-from-apiKey' };
  },
  bearer: async (req: express.Request) => {
    if (req.path === '/protected/forbidden') {
      throw new Forbidden('insufficient scope');
    }
    const auth = req.get('authorization');
    if (auth !== 'Bearer good-token') {
      throw new NotAuthenticated('invalid bearer token');
    }
    return { userId: 'user-from-bearer' };
  }
} as const;

type AuthMap = typeof authHandlers;

// === Handlers ==============================================================

const handlers: HandlerMap<Operations, AuthMap> = {
  publicHello: (_req, res) => {
    res.json({ message: 'hello' });
  },
  protectedTenant: (req, res) => {
    // req.auth.apiKey is typed as { tenantId: string } via the auth
    // handler's return type. The handler also has access to the validated
    // body — proves request validation ran AFTER auth.
    void req.body.note;
    res.json({ tenantId: req.auth.apiKey.tenantId });
  },
  doubleAuth: (req, res) => {
    // Both scheme principals available.
    void req.auth.apiKey.tenantId;
    void req.auth.bearer.userId;
    res.json({ message: `${req.auth.apiKey.tenantId}:${req.auth.bearer.userId}` });
  },
  apiKeyButBuggyHandler: (_req, res) => {
    res.json({ message: 'unreachable — auth throws' });
  },
  forbiddenScheme: (_req, res) => {
    res.json({ message: 'unreachable — auth throws Forbidden' });
  }
};

// === Tests =================================================================

describe('registry-driven router auth', () => {
  let app!: Express;

  beforeAll(async () => {
    const { logger } = await makeCaptureLogger();
    const registry = buildAuthRegistry();
    const router = createRegistryRouter({ registry }).auth(authHandlers).implement(handlers);

    app = express();
    app.use(express.json());
    app.use(setupLogger(logger));
    app.use(router.toExpress());
    app.use(createErrorHandler());
  });

  it('lets public routes through without an auth handler call', async () => {
    const r = await supertest(app).get('/public/hello').expect(200);
    expect(r.body).toEqual({ message: 'hello' });
  });

  it('runs the auth handler and lands the principal on req.auth', async () => {
    const r = await supertest(app)
      .post('/protected/tenant')
      .set('x-api-key', 'good-key')
      .send({ note: 'a real note' })
      .expect(200);
    expect(r.body).toEqual({ tenantId: 'tenant-from-apiKey' });
  });

  it('returns 401 when the auth handler throws NotAuthenticated', async () => {
    const r = await supertest(app)
      .post('/protected/tenant')
      .set('x-api-key', 'wrong-key')
      .send({ note: 'a real note' })
      .expect(401);
    expect(r.body).toMatchObject({ error: true });
  });

  it('runs auth BEFORE request validation (bad body returns 401, not 400)', async () => {
    // The body would fail validation (note must be non-empty), but auth
    // is missing — so we should see 401, not 400. This proves the
    // middleware ordering.
    const r = await supertest(app).post('/protected/tenant').send({ note: '' }).expect(401);
    expect(r.body).toMatchObject({ error: true });
  });

  it('returns 200 when auth passes AND body validation passes', async () => {
    await supertest(app)
      .post('/protected/tenant')
      .set('x-api-key', 'good-key')
      .send({ note: 'good' })
      .expect(200);
  });

  it('returns 400 when auth passes but body is invalid', async () => {
    const r = await supertest(app)
      .post('/protected/tenant')
      .set('x-api-key', 'good-key')
      .send({ note: '' })
      .expect(400);
    expect(r.body.info.body.properties.note.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('runs every scheme handler when an operation declares multiple (AND)', async () => {
    const r = await supertest(app)
      .get('/protected/double')
      .set('x-api-key', 'good-key')
      .set('authorization', 'Bearer good-token')
      .expect(200);
    expect(r.body.message).toBe('tenant-from-apiKey:user-from-bearer');
  });

  it('returns 401 if any scheme in a multi-scheme AND fails', async () => {
    await supertest(app)
      .get('/protected/double')
      .set('x-api-key', 'good-key')
      // missing authorization header
      .expect(401);
  });

  it('routes Forbidden from an auth handler to 403', async () => {
    await supertest(app)
      .get('/protected/forbidden')
      .set('authorization', 'Bearer good-token')
      .expect(403);
  });

  it('wraps a plain Error thrown from an auth handler into 401, not 500', async () => {
    // The buggy handler throws `new Error('database connection failed')`
    // — a plain Error, not an HTTPError. Without the wrap, the global
    // error handler would answer 500. The middleware wraps as
    // NotAuthenticated so the client sees 401 (and 5xx-only logging
    // doesn't fire for what is, semantically, a credential validation
    // failure).
    await supertest(app).get('/protected/buggy').set('x-api-key', 'good-key').expect(401);
  });
});

describe('registry-driven router auth — setup-time guards', () => {
  it('throws at toExpress when an operation declares OR-style security', () => {
    const registry: TypedRegistry = new TypedRegistry();
    registry.registerSecurityScheme('apiKey', {
      type: 'apiKey',
      name: 'x-api-key',
      in: 'header'
    });
    registry.registerSecurityScheme('bearer', { type: 'http', scheme: 'bearer' });

    registry.registerPath({
      operationId: 'orStyle',
      method: 'get',
      path: '/or-style',
      security: [{ apiKey: [] }, { bearer: [] }],
      responses: {
        200: { description: 'ok', content: { 'application/json': { schema: HelloResponse } } }
      }
    });

    const router = createRegistryRouter({ registry })
      .auth({
        apiKey: async () => ({}),
        bearer: async () => ({})
      })
      .implement({
        orStyle: (_req, res) => {
          res.json({ message: 'unreachable' });
        }
      });

    expect(() => router.toExpress()).toThrow(/OR-style security/);
  });
});
