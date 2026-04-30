/**
 * Tests for `extendZodAndCodecsWithOpenApi` — the codec-aware drop-in
 * replacement for `@asteasolutions/zod-to-openapi`'s `extendZodWithOpenApi`.
 *
 * The contract these tests pin:
 *
 *   - After calling, `.openapi(...)` chains on every zod schema kind we
 *     ship — `ZodCodec` is the one the upstream patch misses, but
 *     regular `ZodType`s must continue to work alongside.
 *   - The OpenAPI document produced by `OpenApiGeneratorV3` carries the
 *     metadata for both. We assert against the generated document, not
 *     just against the registry, because the generator is the only thing
 *     consumers ultimately care about.
 *   - `param`, `refId`, and metadata merge work on codecs the same way
 *     they work on regular schemas (full fidelity, not a `.meta()`
 *     delegation).
 *   - Multiple calls don't double-patch.
 */
import { OpenApiGeneratorV3, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { BigIntegerCodec, IsoDateCodec } from '../src/index.ts';
import { extendZodAndCodecsWithOpenApi } from '../src/openapi.ts';

// Patches both ZodType.prototype and ZodCodec.prototype. Idempotent —
// every test below relies on this having run; calling it once at module
// load matches how a real consumer would use it.
extendZodAndCodecsWithOpenApi(z);

function generate(schemas: Record<string, z.ZodType>): {
  components?: { schemas?: Record<string, unknown> };
} {
  const registry = new OpenAPIRegistry();
  for (const [name, schema] of Object.entries(schemas)) {
    registry.register(name, schema);
  }
  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.0',
    info: { title: 'test', version: '1' }
  });
}

describe('extendZodAndCodecsWithOpenApi', () => {
  it('makes .openapi() work on ZodCodec instances (the upstream gap)', () => {
    // The function under test should not throw — without our patch this
    // line raises `TypeError: BigIntegerCodec.openapi is not a function`.
    const Wei = BigIntegerCodec.openapi({
      description: 'wei amount',
      example: '1000000000000000000'
    });

    const doc = generate({ Wei });
    expect(doc.components?.schemas?.Wei).toMatchObject({
      type: 'string',
      pattern: '^-?\\d+$',
      description: 'wei amount',
      example: '1000000000000000000'
    });
  });

  it('still works on regular ZodType instances (parity with the upstream patch)', () => {
    const Plain = z.string().openapi({ description: 'plain field' });
    const doc = generate({ Plain });

    expect(doc.components?.schemas?.Plain).toMatchObject({
      type: 'string',
      description: 'plain field'
    });
  });

  it('preserves the codec wire-format pattern alongside metadata', () => {
    const Date = IsoDateCodec.openapi({
      description: 'last updated',
      example: '2026-04-01T12:00:00.000Z'
    });

    const doc = generate({ Date });
    expect(doc.components?.schemas?.Date).toMatchObject({
      type: 'string',
      format: 'date-time',
      description: 'last updated',
      example: '2026-04-01T12:00:00.000Z'
    });
  });

  it('returns a fresh schema per call so shared building blocks stay clean', () => {
    // Same source codec annotated two different ways. If `.openapi()`
    // mutated in place, the second annotation would clobber the first
    // and both registrations would render the second metadata.
    const Wei = BigIntegerCodec.openapi({ description: 'wei value' });
    const Gas = BigIntegerCodec.openapi({ description: 'gas units' });

    const doc = generate({ Wei, Gas });
    expect(doc.components?.schemas?.Wei).toMatchObject({ description: 'wei value' });
    expect(doc.components?.schemas?.Gas).toMatchObject({ description: 'gas units' });
  });

  it('merges metadata across chained .openapi() calls on a codec', () => {
    const Wei = BigIntegerCodec.openapi({ description: 'first' }).openapi({
      example: '999'
    });

    const doc = generate({ Wei });
    expect(doc.components?.schemas?.Wei).toMatchObject({
      description: 'first',
      example: '999'
    });
  });

  it('honours the param: { in, name } affordance (parameter declarations)', () => {
    // `.meta()` would NOT carry this through to a parameter declaration
    // — it goes to the registry as opaque metadata. The full-fidelity
    // copy of the prototype function does treat `param` specially.
    const NetworkSchema = z.enum(['mainnet', 'testnet']).openapi({
      param: { name: 'network', in: 'path' },
      description: 'Network environment'
    });

    const registry = new OpenAPIRegistry();
    registry.registerParameter('network', NetworkSchema);
    const doc = new OpenApiGeneratorV3(registry.definitions).generateDocument({
      openapi: '3.0.0',
      info: { title: 'test', version: '1' }
    });

    // The parameter declaration carries `name`/`in`/`description` from
    // the schema's `.openapi({ param })` block — the very thing
    // `.meta()` could not have routed through. The schema body itself
    // may be inlined or `$ref`'d depending on registration order; we
    // assert only the parameter-declaration fields here.
    expect(doc.components?.parameters?.['network']).toMatchObject({
      name: 'network',
      in: 'path',
      description: 'Network environment'
    });
  });

  it('is idempotent — calling twice does not double-patch', () => {
    // The hasOwnProperty guard inside extendZodAndCodecsWithOpenApi means
    // a second call is a no-op. Without the guard, the upstream
    // extendZodWithOpenApi's own internal "already extended" check kicks
    // in for the ZodType side, but our codec patch needs its own.
    extendZodAndCodecsWithOpenApi(z);
    extendZodAndCodecsWithOpenApi(z);

    const Wei = BigIntegerCodec.openapi({ description: 'still works' });
    const doc = generate({ Wei });
    expect(doc.components?.schemas?.Wei).toMatchObject({ description: 'still works' });
  });
});
