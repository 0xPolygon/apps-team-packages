/**
 * End-to-end integration tests for the registry-driven router.
 *
 * Spins up a real Express app via `createRegistryRouter().implement().toExpress()`
 * — the production code path — with a registry containing operations that
 * exercise every assumption in `validation.ts` and `index.ts`:
 *
 *   - encode-side behaviour for non-codec, codec-field, and top-level codec
 *     responses (the question that motivated this file: does `z.encode`
 *     work on `z.string()` / plain objects, not just on `ZodCodec`?);
 *   - response-status routing (the validator picks the schema for the
 *     handler-set status code, falls through unchanged when none registered);
 *   - request validation across params / query / body / headers, with
 *     codec decode mutating `req.params`/`req.query`/`req.body` to the
 *     runtime types before the handler runs;
 *   - error paths: synchronous and async handler throws, and `z.encode`
 *     failures from the patched `res.json`, all reaching `createErrorHandler`
 *     and producing 500 responses without the process crashing.
 *
 * Anything that's a "feels like it works" assumption gets a test here
 * rather than living in someone's head.
 */

import type { Express } from 'express';

import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import express, { json } from 'express';
import supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TypedRegistry } from '@polygonlabs/openapi-registry';
import { Int64Codec, IsoDateCodec } from '@polygonlabs/zod-codecs';

import type { HandlerMap } from '../../src/registry/index.ts';
import type { Captured } from '../helpers/captureLogger.ts';

import { setupLogger } from '../../src/context.ts';
import { createErrorHandler } from '../../src/errors.ts';
import { createRegistryRouter } from '../../src/registry/index.ts';
import { makeCaptureLogger } from '../helpers/captureLogger.ts';

extendZodWithOpenApi(z);

// === Schemas ===============================================================

const HelloResponse = z.object({ message: z.string() });
const Item = z.object({
  id: Int64Codec,
  label: z.string(),
  createdAt: IsoDateCodec
});
const NotFoundShape = z.object({ error: z.literal(true), message: z.string() });
const HeaderEcho = z.object({ apiVersion: z.string() });

// === Registry ==============================================================

const buildRegistry = () =>
  new TypedRegistry()
    // Plain non-codec response.
    .registerPath({
      operationId: 'getHello',
      method: 'get',
      path: '/hello',
      responses: {
        200: { description: 'ok', content: { 'application/json': { schema: HelloResponse } } }
      }
    })
    // Top-level codec response (Int64Codec on its own).
    .registerPath({
      operationId: 'getCounter',
      method: 'get',
      path: '/counter',
      responses: {
        200: { description: 'ok', content: { 'application/json': { schema: Int64Codec } } }
      }
    })
    // Multi-status with codec field on the success body.
    .registerPath({
      operationId: 'getItem',
      method: 'get',
      path: '/items/{id}',
      request: {
        params: z.object({ id: Int64Codec })
      },
      responses: {
        200: { description: 'ok', content: { 'application/json': { schema: Item } } },
        404: {
          description: 'not found',
          content: { 'application/json': { schema: NotFoundShape } }
        }
      }
    })
    // Body validation + codec decode on a query param.
    .registerPath({
      operationId: 'createItem',
      method: 'post',
      path: '/items',
      request: {
        query: z.object({ tag: z.string().optional() }),
        body: {
          content: {
            'application/json': {
              schema: z.object({ label: z.string().min(1).max(80), createdAt: IsoDateCodec })
            }
          }
        }
      },
      responses: {
        200: { description: 'ok', content: { 'application/json': { schema: Item } } }
      }
    })
    // Header validation.
    .registerPath({
      operationId: 'echoHeaders',
      method: 'get',
      path: '/echo',
      request: {
        headers: z.object({
          // express lowercases header names; openapi-side schema has to match.
          'x-api-version': z.string()
        })
      },
      responses: {
        200: { description: 'ok', content: { 'application/json': { schema: HeaderEcho } } }
      }
    })
    // Synchronous throw.
    .registerPath({
      operationId: 'syncBoom',
      method: 'get',
      path: '/sync-boom',
      responses: {
        200: { description: 'ok', content: { 'application/json': { schema: HelloResponse } } }
      }
    })
    // Async (rejected promise) throw.
    .registerPath({
      operationId: 'asyncBoom',
      method: 'get',
      path: '/async-boom',
      responses: {
        200: { description: 'ok', content: { 'application/json': { schema: HelloResponse } } }
      }
    })
    // Handler returns a body that doesn't satisfy the response schema —
    // z.encode should fail and route to the error handler.
    .registerPath({
      operationId: 'badShape',
      method: 'get',
      path: '/bad-shape',
      responses: {
        200: { description: 'ok', content: { 'application/json': { schema: HelloResponse } } }
      }
    })
    // Handler emits a status code that has no schema — should pass through
    // unchanged via the original res.json (no encode attempted).
    .registerPath({
      operationId: 'unregisteredStatus',
      method: 'get',
      path: '/unregistered-status',
      responses: {
        200: { description: 'ok', content: { 'application/json': { schema: HelloResponse } } }
      }
    })
    // Multi-section validation: params + headers + body all required, all
    // can be made to fail in a single request to confirm the validator
    // aggregates failures across sections rather than short-circuiting on
    // the first.
    .registerPath({
      operationId: 'multiCheck',
      method: 'post',
      path: '/multi/{id}',
      request: {
        params: z.object({ id: Int64Codec }),
        headers: z.object({ 'x-required': z.string() }),
        body: {
          content: {
            'application/json': {
              schema: z.object({ label: z.string().min(1) })
            }
          }
        }
      },
      responses: {
        200: { description: 'ok', content: { 'application/json': { schema: HelloResponse } } }
      }
    });

import type { OperationsOf } from '@polygonlabs/openapi-registry';
type Operations = OperationsOf<typeof buildRegistry>;

// === Handlers ==============================================================

const handlers: HandlerMap<Operations> = {
  getHello: (_req, res) => {
    res.json({ message: 'hello' });
  },
  getCounter: (_req, res) => {
    // Response schema is `Int64Codec`, so the typed res.json accepts the
    // runtime shape (bigint) and the response validator's `z.encode` runs
    // the codec encode side to a digit-string before send.
    res.json(9_007_199_254_740_993n);
  },
  getItem: (req, res) => {
    // The path-param codec should have decoded `req.params.id` to bigint by
    // now. We assert on its runtime type by branching on value, then return
    // a 404 for an unknown id and a 200 for a known one.
    const id: bigint = req.params.id;
    if (id === 999n) {
      res.status(404).json({ error: true, message: 'no such item' });
      return;
    }
    res.json({
      id,
      label: `item ${String(id)}`,
      createdAt: new Date('2026-04-30T00:00:00.000Z')
    });
  },
  createItem: (req, res) => {
    // body.createdAt should already be a Date instance (codec decode);
    // body.label is a plain string; query.tag is optional.
    const body = req.body;
    res.json({
      id: 1n,
      label: body.label,
      createdAt: body.createdAt
    });
  },
  echoHeaders: (req, res) => {
    const ver = req.headers['x-api-version'];
    res.json({ apiVersion: typeof ver === 'string' ? ver : '' });
  },
  syncBoom: () => {
    throw new Error('sync boom');
  },
  asyncBoom: async () => {
    await Promise.resolve();
    throw new Error('async boom');
  },
  badShape: (_req, res) => {
    // Schema requires { message: string }; we send a number — z.encode throws.
    res.json({ message: 42 as unknown as string });
  },
  unregisteredStatus: (_req, res) => {
    // 201 has no registered schema — body should pass through unchanged.
    // The body shape doesn't match the 200 schema on purpose; cast through
    // the typed res.json signature to surface the assertion at runtime.
    (res.status(201).json as (body: unknown) => unknown)({ totally: 'unregistered' });
  },
  multiCheck: (_req, res) => {
    // Reachable only when params + headers + body all parse — the
    // multi-failure test never gets here.
    res.json({ message: 'ok' });
  }
};

// === Tests =================================================================

describe('registry-driven router integration', () => {
  let app!: Express;
  let captured!: Captured[];

  beforeAll(async () => {
    // Real logger captured to an in-memory stream — primes the
    // `setupLogger` fallback so `getLogger()` inside `createErrorHandler`
    // resolves to a working logger when 5xx responses are emitted. The
    // captured array is also asserted on by the response-validation tests
    // below to confirm 5xx emissions log at `error` level (so Sentry
    // alerts fire on server bugs).
    const cap = await makeCaptureLogger();
    captured = cap.captured;

    const registry = buildRegistry();
    const router = createRegistryRouter({ registry }).implement(handlers);

    app = express();
    app.use(json());
    app.use(setupLogger(cap.logger));
    app.use(router.toExpress());
    app.use(createErrorHandler());
  });

  describe('response encoding', () => {
    it('passes a plain (non-codec) object through unchanged', async () => {
      const r = await supertest(app).get('/hello').expect(200);
      expect(r.body).toEqual({ message: 'hello' });
    });

    it('encodes a top-level codec — bigint → wire digit-string', async () => {
      const r = await supertest(app).get('/counter').expect(200);
      expect(r.body).toBe('9007199254740993');
    });

    it('encodes mixed codec + non-codec fields', async () => {
      const r = await supertest(app).get('/items/42').expect(200);
      expect(r.body).toEqual({
        id: '42',
        label: 'item 42',
        createdAt: '2026-04-30T00:00:00.000Z'
      });
    });
  });

  describe('response status routing', () => {
    it('picks the 200 schema when handler returns 200', async () => {
      const r = await supertest(app).get('/items/1').expect(200);
      expect(r.body).toMatchObject({ id: '1', label: 'item 1' });
    });

    it('picks the 404 schema when handler sets status 404', async () => {
      const r = await supertest(app).get('/items/999').expect(404);
      expect(r.body).toEqual({ error: true, message: 'no such item' });
    });

    it('passes through unchanged for an unregistered status (no encode attempted)', async () => {
      const r = await supertest(app).get('/unregistered-status').expect(201);
      // The body is { totally: 'unregistered' } — would not satisfy the 200
      // schema (which requires `message`), but no encode runs at status 201.
      expect(r.body).toEqual({ totally: 'unregistered' });
    });
  });

  describe('request validation and codec decode', () => {
    it('decodes Int64Codec path param to bigint before handler runs', async () => {
      // The handler asserts `req.params.id === 999n` (bigint comparison) to
      // pick the 404 branch — if the codec decode didn't run, we'd see a
      // string '999' here and the branch would never hit.
      await supertest(app).get('/items/999').expect(404);
    });

    it('returns 400 keyed by section with a tree of issues on body validation failure', async () => {
      const r = await supertest(app)
        .post('/items')
        .send({ label: '', createdAt: 'not-a-date' })
        .expect(400);
      expect(r.body).toMatchObject({ error: true, message: 'Invalid request' });
      // `info.body` is the `z.treeifyError` shape for the body schema —
      // a recursive tree that mirrors the input shape with `errors: string[]`
      // at every level. Clients wire `info.body.properties.label.errors[0]`
      // directly into form-level feedback rather than walking a path array.
      expect(r.body.info.body.properties.label.errors.length).toBeGreaterThanOrEqual(1);
      expect(r.body.info.body.properties.createdAt.errors.length).toBeGreaterThanOrEqual(1);
    });

    it('returns 400 keyed by section when path-param decode fails', async () => {
      const r = await supertest(app).get('/items/not-a-number').expect(400);
      expect(r.body).toMatchObject({
        error: true,
        message: 'Invalid request'
      });
      expect(r.body.info.params.properties.id.errors.length).toBeGreaterThanOrEqual(1);
    });

    it('decodes a body codec field (IsoDateCodec)', async () => {
      const r = await supertest(app)
        .post('/items')
        .send({ label: 'thing', createdAt: '2026-04-30T12:00:00.000Z' })
        .expect(200);
      // The handler echoed body.createdAt straight back; the response goes
      // through Item's IsoDateCodec encode which produces an ISO string.
      expect(r.body.createdAt).toBe('2026-04-30T12:00:00.000Z');
      expect(r.body.label).toBe('thing');
    });

    it('validates request headers via the headers schema', async () => {
      const ok = await supertest(app).get('/echo').set('x-api-version', '7').expect(200);
      expect(ok.body).toEqual({ apiVersion: '7' });

      const bad = await supertest(app).get('/echo').expect(400);
      expect(bad.body).toMatchObject({ error: true, message: 'Invalid request' });
      expect(
        bad.body.info.headers.properties['x-api-version'].errors.length
      ).toBeGreaterThanOrEqual(1);
    });

    it('aggregates failures across params, body, and headers in one response', async () => {
      // /multi/{id} declares all three sections; we deliberately break each:
      // - id: 'not-a-number' fails the Int64Codec params schema,
      // - the x-required header is missing,
      // - body.label is empty (min(1)).
      // The validator should surface every section's failure in one go
      // rather than short-circuiting on the first.
      const r = await supertest(app).post('/multi/not-a-number').send({ label: '' }).expect(400);
      expect(r.body).toMatchObject({ error: true, message: 'Invalid request' });
      expect(r.body.info.params.properties.id.errors.length).toBeGreaterThanOrEqual(1);
      expect(r.body.info.headers.properties['x-required'].errors.length).toBeGreaterThanOrEqual(1);
      expect(r.body.info.body.properties.label.errors.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('handler error paths', () => {
    it('routes synchronous throws to the global error handler (500)', async () => {
      const r = await supertest(app).get('/sync-boom').expect(500);
      expect(r.body).toMatchObject({ error: true });
    });

    it('routes async (rejected promise) throws to the global error handler (500)', async () => {
      const r = await supertest(app).get('/async-boom').expect(500);
      expect(r.body).toMatchObject({ error: true });
    });

    it('routes z.encode failures from res.json to the global error handler (500)', async () => {
      const r = await supertest(app).get('/bad-shape').expect(500);
      expect(r.body).toMatchObject({ error: true });
    });

    it('encode failures surface a safe hand-written message, not the ZodError text', async () => {
      const r = await supertest(app).get('/bad-shape').expect(500);
      expect(r.body).property('message', 'Response failed schema validation');
      expect(JSON.stringify(r.body)).not.contain('invalid_type');
      expect(JSON.stringify(r.body)).not.contain('"code"');
    });

    it('encode failures attach operationId to info for triage', async () => {
      const r = await supertest(app).get('/bad-shape').expect(500);
      expect(r.body).nested.property('info.operationId', 'badShape');
    });

    it('encode failures log at error level at the detection site (Sentry-visible)', async () => {
      captured.length = 0;
      await supertest(app).get('/bad-shape').expect(500);
      const errorLogs = captured.filter(
        (c) => c.level === 'error' && c.message === 'response failed schema validation'
      );
      expect(errorLogs).property('length').greaterThan(0);
      expect(errorLogs[0]).property('operationId', 'badShape');
    });
  });
});
