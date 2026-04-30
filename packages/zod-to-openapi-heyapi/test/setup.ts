// Codegen entry point — invoked by `pnpm run codegen` (via `test/codegen.ts`)
// to refresh the committed `test/__generated__/` snapshot.
//
// __generated__/ is checked into the repo as a test fixture. Tests consume
// it directly: runtime.test.ts asserts on the textual emit, types.test.ts
// imports the emitted types for compile-time `Equal<>` assertions, and
// api.test.ts imports the generated client + SDK for end-to-end MSW tests.
// Treating it as a snapshot keeps CI deterministic (no codegen step needed
// before typecheck/lint) and surfaces emit changes in PR diffs — exactly
// what we want when reviewing plugin-level changes.
//
// To refresh after changing src/index.ts, fixtures, or bumping the
// @hey-api/openapi-ts dep:
//
//     pnpm --filter @polygonlabs/zod-to-openapi-heyapi run codegen
//
// The output is deterministic for a given fixture registry + hey-api
// version, so a normal refresh produces a no-op git diff unless something
// actually changed.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { $, createClient } from '@hey-api/openapi-ts';

import { registryPlugin } from '../src/index.ts';
import { OpenApiGeneratorV3, fixtureRegistry, generateFixtureSpec } from './fixtures/registry.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const generatedDir = resolve(here, '__generated__');
const generatedSpecFile = resolve(generatedDir, 'openapi.json');

export async function setup(): Promise<void> {
  rmSync(generatedDir, { recursive: true, force: true });
  mkdirSync(generatedDir, { recursive: true });

  const spec = generateFixtureSpec();

  const plugin = await registryPlugin({
    registry: fixtureRegistry,
    // Resolves both for the audit (plugin dynamic-imports it from src/) and
    // for the generated client (api.test.ts imports the generated SDK, which
    // imports schemas from this same alias — both consumers live inside this
    // package, so package.json `imports` resolves it). The alias is declared
    // in this package's `package.json#imports` field.
    schemasFrom: '#test-fixtures/schemas',
    generatorClass: OpenApiGeneratorV3,
    $
  });

  await createClient({
    // The shared types declare `path` as `ApiRegistryShorthands | AnyString | JsonSchema`
    // — the JsonSchema branch is "pass the parsed spec directly" but it isn't
    // exposed cleanly in the public types, so a single cast is unavoidable.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: spec as any,
    output: {
      path: generatedDir,
      clean: true,
      // Emit `.ts` extensions on the scaffolding's relative imports (matches
      // our convention everywhere else in the workspace). TypeScript's
      // `rewriteRelativeImportExtensions` lets these compile to `.js` if the
      // files ever get built — for tests they're consumed directly.
      module: { extension: '.ts' }
    },
    plugins: [
      // Registry plugin must come before @hey-api/typescript so its response
      // type symbols are registered first (querySymbol returns index 0).
      plugin as never,
      '@hey-api/typescript',
      '@hey-api/client-fetch',
      // includeInEntry: false is required — the registry plugin emits
      // wrappers under the same names as @hey-api/sdk's emissions and
      // both can't land in the auto-generated entry barrel. The
      // plugin's pre-flight check throws with the exact config to
      // write if you forget.
      { name: '@hey-api/sdk', transformer: true, includeInEntry: false }
    ],
    logs: { level: 'silent' }
  });

  // Write the spec last — `output.clean: true` wipes the directory at the
  // start of createClient, so this has to come after.
  writeFileSync(generatedSpecFile, JSON.stringify(spec, null, 2) + '\n');
}
