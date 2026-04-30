// Verifies the plugin's silent-skip diagnostic — emitted when a route's
// input slot holds a ZodType that has a refId (chained `.openapi('Name')`
// or returned from `register('Name', schema)`) but isn't identity-equal
// to a named export of `schemasFrom`. That's the user-error case where
// the post-clone instance diverged from the export, not a deliberate
// inline schema. Anonymous inline schemas (no refId) silently skip
// without warning.

import { OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registryPlugin } from '../src/index.ts';
import { z } from './fixtures/zod.ts';

describe('input slot misalignment diagnostic', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('warns when a route uses a refId-bearing schema that is not the exported instance', async () => {
    // Build a registry whose route holds a post-`register()` clone in
    // request.params, but whose `schemasFrom` exports the pre-`register`
    // instance under the same name. Identity lookup fails; the schema
    // has a refId; we should warn.
    const InnerParams = z.object({ id: z.string() });
    const registry = new OpenAPIRegistry();
    const registeredClone = registry.register('InnerParams', InnerParams);
    registry.registerPath({
      operationId: 'getThing',
      method: 'get',
      path: '/things/{id}',
      // Use the post-register clone — identity doesn't match the
      // exported `InnerParams` instance.
      request: { params: registeredClone },
      responses: {
        200: {
          description: 'ok',
          content: { 'application/json': { schema: registeredClone } }
        }
      }
    });

    // The plugin reads `schemasFrom` via dynamic import. Build a one-
    // off aux module on disk that exports the PRE-register `InnerParams`
    // instance via `globalThis` so identity is preserved across the
    // dynamic import boundary (the alternative — serialising a Zod
    // schema to disk — isn't possible).
    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'zod-to-openapi-heyapi-warn-'));
    const moduleFile = join(dir, 'schemas.mjs');

    try {
      // Write a module that re-exports the PRE-register instance. We
      // can't write the actual instance to disk (it's a runtime value),
      // but we can structure-dump the schema and re-construct it.
      // Easier still: use the Node `--experimental-vm-modules` path or
      // inject via package.json `imports`. Simpler still: write a
      // stub that exports a placeholder, then patch the plugin's
      // identity map after the fact.
      //
      // The plugin's audit reads schemas via `await import(schemasFrom)`
      // and Object.entries. If `schemasFrom` is a `file:` URL pointing
      // to a `.mjs` that re-exports a known schema, identity is
      // preserved across the import. So we put our `InnerParams` on
      // globalThis and have the stub module re-import it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__InnerParamsForWarnTest = InnerParams;
      writeFileSync(
        moduleFile,
        `export const InnerParams = globalThis.__InnerParamsForWarnTest;\n`
      );

      // Plugin setup is sync from our perspective; the audit runs
      // before any user-visible work, and the warning is emitted from
      // collectInputSchemasFromRegistry.
      await registryPlugin({
        registry,
        schemasFrom: `file://${moduleFile}`,
        generatorClass: OpenApiGeneratorV3,
        $: (() => undefined) as never
      });

      const calls = warnSpy.mock.calls.map((c) => String(c[0]));
      const matchingWarning = calls.find(
        (msg) =>
          msg.includes("operation 'getThing'") &&
          msg.includes('request.path') &&
          msg.includes("'InnerParams'")
      );
      expect(matchingWarning).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).__InnerParamsForWarnTest;
    }
  });

  it('does not warn for anonymous inline schemas (no refId)', async () => {
    // `getThing` uses an inline `z.object(...)` with no `.openapi('Name')`
    // chain and no `register()` round-trip. Plain anonymous schema —
    // intentional silent skip, no warning expected.
    const registry = new OpenAPIRegistry();
    registry.registerPath({
      operationId: 'getThing',
      method: 'get',
      path: '/things/{id}',
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: 'ok',
          content: {
            'application/json': {
              schema: registry.register('AnonReturn', z.object({ value: z.string() }))
            }
          }
        }
      }
    });

    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'zod-to-openapi-heyapi-no-warn-'));
    const moduleFile = join(dir, 'schemas.mjs');

    try {
      // The audit only looks at response refs, so we just need to
      // export `AnonReturn` to satisfy it. The input slot's
      // anonymous schema isn't audited at all.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__AnonReturnForWarnTest = z.object({
        value: z.string()
      });
      writeFileSync(moduleFile, `export const AnonReturn = globalThis.__AnonReturnForWarnTest;\n`);

      // Skip the audit — the response schema isn't actually exported
      // under matching identity; we just need to verify the plugin
      // doesn't warn on the input slot.
      await registryPlugin({
        registry,
        schemasFrom: `file://${moduleFile}`,
        generatorClass: OpenApiGeneratorV3,
        $: (() => undefined) as never
      }).catch(() => {
        /* audit may complain about response schema; ignore — we're testing input warnings only */
      });

      const calls = warnSpy.mock.calls.map((c) => String(c[0]));
      const inputWarnings = calls.filter((msg) => msg.includes('input encoding will be skipped'));
      expect(inputWarnings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).__AnonReturnForWarnTest;
    }
  });
});
