// Regression coverage for registration-based input-slot naming. The
// previous identity-based lookup silently broke under split module
// evaluation (apps-team-ts-template repro, 2026-06): openapi-ts loads the
// user's config through c12/jiti, and when a custom export condition (e.g.
// `@polygonlabs/source`) resolves the schemas package to `.ts` source, the
// registry's module graph and the plugin's own `await import(schemasFrom)`
// evaluate the schemas module separately — two instances of every schema,
// zero identity hits, every codec input transformer silently dropped from
// the emitted client.
//
// Input-slot names now come from registration metadata (the refId that
// `.openapi('Name')` / `register('Name', schema)` attached to the instance
// the route holds), so resolution never consults a second module
// evaluation. The plugin's dynamic import of `schemasFrom` survives only
// as a string-membership audit over export names. These tests pin:
//   1. name resolution with zero instance-identity dependence,
//   2. the loud-failure guard for unregistered codec-bearing slots,
//   3. the intentional silent skip for codec-free anonymous slots, and
//   4. the audit failure for a registered-but-not-exported name.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Int64Codec, IsoDateCodec } from '@polygonlabs/zod-codecs';

import { defineRegistryClientConfig, registryPlugin } from '../src/index.ts';
import { z } from './fixtures/zod.ts';

// Two invocations simulate the two module evaluations of the real split:
// fresh registered ZodObject instances per call, while imported codec
// singletons (Int64Codec) stay shared — exactly the mix the c12/jiti +
// native double-load produces (bare specifiers are externalised to one
// instance; the schemas file itself is evaluated twice).
const makeSchemas = () => ({
  BlockParams: z.object({ blockNumber: Int64Codec }).openapi('BlockParams'),
  RecentQuery: z
    .object({
      cursor: z
        .string()
        .regex(/^[a-z0-9]+$/)
        .optional(),
      since: IsoDateCodec.optional()
    })
    .openapi('RecentQuery'),
  // Deliberately unregistered AND codec-free — the anonymous-inline case.
  PlainParams: z.object({ id: z.uuid() })
});

const buildRegistry = (schemas: ReturnType<typeof makeSchemas>): OpenAPIRegistry => {
  const registry = new OpenAPIRegistry();
  registry.registerPath({
    operationId: 'getBlock',
    method: 'get',
    path: '/blocks/{blockNumber}',
    request: { params: schemas.BlockParams },
    responses: { 200: { description: 'ok' } }
  });
  registry.registerPath({
    operationId: 'listRecent',
    method: 'get',
    path: '/recent',
    request: { query: schemas.RecentQuery },
    responses: { 200: { description: 'ok' } }
  });
  registry.registerPath({
    operationId: 'getPlain',
    method: 'get',
    path: '/plain/{id}',
    request: { params: schemas.PlainParams },
    responses: { 200: { description: 'ok' } }
  });
  return registry;
};

/**
 * Materialise `exportsMap` as an importable on-disk module so the plugin's
 * audit (`await import(schemasFrom)`) can read its export names. Zod
 * schemas are runtime values that can't be serialised, so the module
 * re-exports them via globalThis.
 */
async function withSchemasModule<T>(
  exportsMap: Record<string, unknown>,
  fn: (schemasFrom: string) => Promise<T>
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'zod-to-openapi-heyapi-input-slots-'));
  const moduleFile = join(dir, 'schemas.mjs');
  const key = '__inputSlotRegistrationTestExports';
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any)[key] = exportsMap;
    writeFileSync(
      moduleFile,
      Object.keys(exportsMap)
        .map((name) => `export const ${name} = globalThis.${key}[${JSON.stringify(name)}];\n`)
        .join('')
    );
    return await fn(`file://${moduleFile}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any)[key];
  }
}

describe('registration-based input-slot naming', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('resolves registered codec slots by name across distinct module instances', async () => {
    // Registry from evaluation A, schemasFrom exports evaluation B — the
    // exact instance split that broke the identity-based lookup. Names
    // and structure match; identity never does. Resolution and the audit
    // must both succeed.
    const registry = buildRegistry(makeSchemas());

    await withSchemasModule(makeSchemas(), async (schemasFrom) => {
      const config = await defineRegistryClientConfig({
        registry,
        schemasFrom,
        input: 'unused://spec',
        output: './unused',
        tanstackReactQuery: true
      });

      const isQuery = config.parser?.hooks?.operations?.isQuery;
      expect(isQuery).to.be.a('function');
      if (!isQuery) return;
      // Registered codec ops are claimed by this plugin (excluded from
      // upstream tanstack emission) — proof the slots resolved.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(isQuery({ id: 'getBlock' } as any)).to.equal(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(isQuery({ id: 'listRecent' } as any)).to.equal(false);
      // The anonymous codec-free op is NOT claimed — it stays upstream's.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(isQuery({ id: 'getPlain' } as any)).to.equal(undefined);
    });

    expect(warnSpy.mock.calls).to.have.length(0);
  });

  it('hard-fails with the registration remedy when codec-bearing slots are unregistered', async () => {
    // Same routes, but the codec schemas never went through
    // `.openapi('Name')`. Mode-independent behaviour: the guard fires in
    // a plain single-instance setup, before the audit ever imports
    // schemasFrom (the bogus specifier proves no import is attempted).
    const registry = new OpenAPIRegistry();
    registry.registerPath({
      operationId: 'getBlock',
      method: 'get',
      path: '/blocks/{blockNumber}',
      request: { params: z.object({ blockNumber: Int64Codec }) },
      responses: { 200: { description: 'ok' } }
    });
    registry.registerPath({
      operationId: 'listRecent',
      method: 'get',
      path: '/recent',
      request: { query: z.object({ since: IsoDateCodec.optional() }) },
      responses: { 200: { description: 'ok' } }
    });

    await expect(
      registryPlugin({
        registry,
        schemasFrom: '@polygonlabs/this-package-does-not-exist',
        generatorClass: OpenApiGeneratorV3,
        $: (() => undefined) as never
      })
    ).rejects.toThrow(
      /contain Zod codecs.*but are not registered.*getBlock.*request\.path.*listRecent.*request\.query.*\.openapi\('MySlotSchema'\)/s
    );
  });

  it('silently skips codec-free anonymous inline slots', async () => {
    const registry = new OpenAPIRegistry();
    registry.registerPath({
      operationId: 'getThing',
      method: 'get',
      path: '/things/{id}',
      request: { params: z.object({ id: z.uuid() }) },
      responses: { 200: { description: 'ok' } }
    });

    await withSchemasModule({ Unrelated: z.object({ name: z.string() }) }, async (schemasFrom) => {
      const plugin = await registryPlugin({
        registry,
        schemasFrom,
        generatorClass: OpenApiGeneratorV3,
        $: (() => undefined) as never
      });
      expect(plugin).to.have.property('name', 'registry-validator');
    });

    expect(warnSpy.mock.calls).to.have.length(0);
  });

  it('fails the audit when a registered slot name is not exported from schemasFrom', async () => {
    const registry = new OpenAPIRegistry();
    registry.registerPath({
      operationId: 'getEvents',
      method: 'get',
      path: '/events',
      request: { query: z.object({ since: IsoDateCodec }).openapi('EventsQuery') },
      responses: { 200: { description: 'ok' } }
    });

    await withSchemasModule({ Unrelated: z.object({ id: z.string() }) }, async (schemasFrom) => {
      await expect(
        registryPlugin({
          registry,
          schemasFrom,
          generatorClass: OpenApiGeneratorV3,
          $: (() => undefined) as never
        })
      ).rejects.toThrow(/'EventsQuery' is registered on a request slot but is not a named export/);
    });
  });
});
