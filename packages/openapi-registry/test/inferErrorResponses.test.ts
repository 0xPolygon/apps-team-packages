/**
 * Runtime tests for the standard-error-response inference. The type-level
 * counterpart lives in `typedRegistry.test-d.ts` and pins the same rules
 * at the accumulator's response-slot level.
 */

import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ErrorResponseSchema, ValidationErrorResponseSchema } from '../src/error-schemas.ts';
import { TypedRegistry } from '../src/index.ts';
import { inferStandardErrorResponses } from '../src/inferErrorResponses.ts';

extendZodWithOpenApi(z);

const okResponse = {
  200: {
    description: 'ok',
    content: { 'application/json': { schema: z.object({}) } }
  }
} as const;

describe('inferStandardErrorResponses', () => {
  it('always injects a 500 with ErrorResponseSchema', () => {
    const r = inferStandardErrorResponses({});
    expect(r[500]?.content?.['application/json']?.schema).toBe(ErrorResponseSchema);
  });

  it('injects 400 when request.body is declared', () => {
    const r = inferStandardErrorResponses({ request: { body: z.object({}) } });
    expect(r[400]?.content?.['application/json']?.schema).toBe(ValidationErrorResponseSchema);
  });

  it('injects 400 when request.params is declared', () => {
    const r = inferStandardErrorResponses({ request: { params: z.object({}) } });
    expect(r[400]).toBeDefined();
  });

  it('injects 400 when request.query is declared', () => {
    const r = inferStandardErrorResponses({ request: { query: z.object({}) } });
    expect(r[400]).toBeDefined();
  });

  it('injects 400 when request.headers is declared', () => {
    const r = inferStandardErrorResponses({ request: { headers: z.object({}) } });
    expect(r[400]).toBeDefined();
  });

  it('does NOT inject 400 when request is absent', () => {
    const r = inferStandardErrorResponses({});
    expect(r[400]).toBeUndefined();
  });

  it('does NOT inject 400 when request is empty (no validation keys)', () => {
    const r = inferStandardErrorResponses({ request: {} });
    expect(r[400]).toBeUndefined();
  });

  it('injects 401 with ErrorResponseSchema when security has requirements', () => {
    const r = inferStandardErrorResponses({ security: [{ ApiKeyAuth: [] }] });
    expect(r[401]?.content?.['application/json']?.schema).toBe(ErrorResponseSchema);
  });

  it('does NOT inject 401 when security is absent', () => {
    const r = inferStandardErrorResponses({});
    expect(r[401]).toBeUndefined();
  });

  it('does NOT inject 401 when security is the empty array (OpenAPI "no auth required")', () => {
    const r = inferStandardErrorResponses({ security: [] });
    expect(r[401]).toBeUndefined();
  });

  it('does NOT inject 403 or 404 — those are handler-emitted, not framework-emitted', () => {
    const r = inferStandardErrorResponses({
      request: { body: z.object({}) },
      security: [{ ApiKeyAuth: [] }]
    });
    expect(r[403]).toBeUndefined();
    expect(r[404]).toBeUndefined();
  });
});

describe('TypedRegistry.registerPath auto-inject', () => {
  /**
   * Returns the merged response config the registry stored for a given
   * operationId. Reads through `definitions` rather than the typed `ops`
   * accessor because the latter is type-only.
   */
  function responsesForOp(r: TypedRegistry, operationId: string): Record<string, unknown> {
    for (const def of r.definitions) {
      if ((def as { type?: unknown }).type !== 'route') continue;
      const route = (def as { route: { operationId: string; responses: Record<string, unknown> } })
        .route;
      if (route.operationId === operationId) return route.responses;
    }
    throw new Error(`operation '${operationId}' not registered`);
  }

  it('injects 500 on every route', () => {
    const r = new TypedRegistry().registerPath({
      operationId: 'noValidation',
      method: 'get',
      path: '/x',
      responses: okResponse
    });
    expect(responsesForOp(r, 'noValidation')[500]).toBeDefined();
  });

  it('injects 400 on routes with request validation', () => {
    const r = new TypedRegistry().registerPath({
      operationId: 'withBody',
      method: 'post',
      path: '/x',
      request: { body: { content: { 'application/json': { schema: z.object({}) } } } },
      responses: okResponse
    });
    const responses = responsesForOp(r, 'withBody');
    expect(responses[400]).toBeDefined();
  });

  it('injects 401 on routes with security', () => {
    const r = new TypedRegistry()
      .registerSecurityScheme('ApiKeyAuth', { type: 'apiKey', name: 'x-api-key', in: 'header' })
      .registerPath({
        operationId: 'authed',
        method: 'get',
        path: '/x',
        security: [{ ApiKeyAuth: [] }],
        responses: okResponse
      });
    expect(responsesForOp(r, 'authed')[401]).toBeDefined();
  });

  it('does NOT inject 400 on routes with no request validation', () => {
    const r = new TypedRegistry().registerPath({
      operationId: 'plain',
      method: 'get',
      path: '/x',
      responses: okResponse
    });
    expect(responsesForOp(r, 'plain')[400]).toBeUndefined();
  });

  it('preserves the user-authored 200 alongside auto-injected error responses', () => {
    const r = new TypedRegistry().registerPath({
      operationId: 'withBody',
      method: 'post',
      path: '/x',
      request: { body: { content: { 'application/json': { schema: z.object({}) } } } },
      responses: okResponse
    });
    const responses = responsesForOp(r, 'withBody');
    expect(responses[200]).toBeDefined();
    expect(responses[400]).toBeDefined();
    expect(responses[500]).toBeDefined();
  });

  it('user-authored responses win over inferred ones (override semantics)', () => {
    // The user declares a domain-specific 500 shape with a custom schema —
    // the inferred 500 (ErrorResponseSchema) must be displaced.
    const CustomFiveHundred = z.object({ custom: z.literal(true) });
    const r = new TypedRegistry().registerPath({
      operationId: 'customFiveHundred',
      method: 'get',
      path: '/x',
      responses: {
        ...okResponse,
        500: {
          description: 'custom 500',
          content: { 'application/json': { schema: CustomFiveHundred } }
        }
      }
    });
    const responses = responsesForOp(r, 'customFiveHundred') as Record<
      string,
      { content: { 'application/json': { schema: unknown } } }
    >;
    expect(responses[500]?.content?.['application/json']?.schema).toBe(CustomFiveHundred);
  });
});
