// Regression tests for consumer-anchored `schemasFrom` resolution.
//
// The bug these pin: the audit's dynamic import used to execute with THIS
// package as the referrer, so a consumer's `#` aliases could never resolve —
// yet the old suite passed, because its fixtures live in this same package
// (the one topology where referrer == alias-declarer). These tests therefore
// build a REAL consumer: a synthetic package in a temp directory, foreign to
// this package's scope, and resolve into it from here.

import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { importFromConsumer } from '../src/import-from-consumer.ts';

let consumerDir!: string;
let outputDir!: string;

beforeAll(async () => {
  consumerDir = await mkdtemp(join(tmpdir(), 'heyapi-consumer-'));
  // Deliberately nested and NOT pre-created: the helper mkdirs it, and its
  // package scope must resolve to the consumer's package.json.
  outputDir = join(consumerDir, 'src', 'generated');
  await writeFile(
    join(consumerDir, 'package.json'),
    JSON.stringify({
      name: 'synthetic-consumer',
      type: 'module',
      imports: { '#schemas': './src/schemas.mjs' }
    })
  );
  await mkdir(join(consumerDir, 'src'), { recursive: true });
  await writeFile(
    join(consumerDir, 'src', 'schemas.mjs'),
    "export const MARKER = 'consumer schemas barrel';\n"
  );
  // A bare-name dependency, present ONLY in the consumer's node_modules —
  // invisible from this package's scope.
  const dep = join(consumerDir, 'node_modules', 'consumer-only-dep');
  await mkdir(dep, { recursive: true });
  await writeFile(
    join(dep, 'package.json'),
    JSON.stringify({ name: 'consumer-only-dep', type: 'module', exports: { '.': './index.mjs' } })
  );
  await writeFile(join(dep, 'index.mjs'), "export const MARKER = 'consumer-only dep';\n");
});

afterAll(async () => {
  await rm(consumerDir, { recursive: true, force: true });
});

describe('importFromConsumer', () => {
  it("resolves the consumer's '#' imports alias — the same-package canonical pattern", async () => {
    const mod = await importFromConsumer('#schemas', outputDir);
    expect(mod).property('MARKER', 'consumer schemas barrel');
  });

  it("resolves a bare package name from the CONSUMER's node_modules, not this package's", async () => {
    const mod = await importFromConsumer('consumer-only-dep', outputDir);
    expect(mod).property('MARKER', 'consumer-only dep');
  });

  it('rejects relative specifiers with guidance (emitted imports must be location-independent)', async () => {
    await expect(importFromConsumer('./src/schemas.mjs', outputDir)).rejects.toThrow(
      /relative path.*cannot work|location-independent|imports.*alias/s
    );
  });

  it('cleans its trampoline out of the output dir on success and on failure', async () => {
    await importFromConsumer('#schemas', outputDir);
    await importFromConsumer('missing-package-zzz', outputDir).catch(() => undefined);
    const leftovers = (await readdir(outputDir)).filter((name) =>
      name.startsWith('.zod-to-openapi-heyapi-anchor-')
    );
    expect(leftovers).lengthOf(0);
  });

  it("an alias UNDECLARED by the consumer still fails loudly (the plugin's own aliases must not leak in)", async () => {
    // '#test-fixtures/schemas' IS declared by this plugin package's own
    // package.json — the old resolution would have found it. Anchored to the
    // synthetic consumer, it must not.
    await expect(importFromConsumer('#test-fixtures/schemas', outputDir)).rejects.toThrow(
      /Missing "#|not defined in package|PACKAGE_IMPORT_NOT_DEFINED/
    );
  });
});
