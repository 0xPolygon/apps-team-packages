/**
 * Imports `schemasFrom` with the CONSUMER package as the resolution
 * referrer — instead of this plugin's own install location.
 *
 * Why this exists: Node resolves every import — static and dynamic
 * identically — against the module that contains the import statement
 * (the referrer). A bare `await import(schemasFrom)` in this package
 * therefore resolves from `node_modules/@polygonlabs/zod-to-openapi-heyapi/`,
 * with two consequences:
 *
 *   - `package.json#imports` aliases (`'#schemas'`) can NEVER resolve:
 *     `#` subpath imports are looked up in the referrer's own package,
 *     and the consumer's aliases are invisible from here. This broke the
 *     documented same-package recipe for every real consumer — while the
 *     plugin's own test suite passed, because there the plugin IS the
 *     consumer (same package scope), the one topology that masks the bug.
 *   - Bare package names resolved only via the package manager's layout
 *     luck (pnpm's internal store hoist), not via the consumer's actual
 *     dependency graph.
 *
 * Mechanism: a throwaway trampoline module is written into the consumer's
 * `node_modules` and imported; a dynamic import executed FROM that module
 * has the consumer as its package scope, so every specifier form resolves
 * with full ESM semantics — `#` aliases (with their conditions), `exports`
 * maps, and the running process's `--conditions` flags (which a
 * `createRequire`-based resolver would NOT honor: `require.resolve` applies
 * CJS conditions and rejects import-only `exports`, e.g. the team's
 * `@polygonlabs/source`-pattern packages).
 *
 * Relative specifiers are REJECTED with guidance: the generated client
 * emits `import { X } from '<schemasFrom>'` into the output directory, so
 * the specifier must resolve identically from anywhere inside the consumer
 * package — which only `#` aliases and package names do. A relative path
 * that happened to resolve at audit time would still break at consumer
 * runtime from the generated files' location.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @param specifier A location-independent ES module specifier: a `#` imports
 * alias or a bare package name / subpath.
 * @param outputDir The codegen OUTPUT directory — where the generated client
 * (and its emitted `import ... from '<schemasFrom>'` statements) will live.
 * Anchoring resolution there makes the audit resolve the specifier exactly
 * as the generated code will at consumer runtime. Created if absent (the
 * plugin is about to write into it anyway).
 */
export async function importFromConsumer(
  specifier: string,
  outputDir: string
): Promise<Record<string, unknown>> {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    throw new Error(
      `[zod-to-openapi-heyapi] schemasFrom='${specifier}' is a relative path, which cannot ` +
        `work: the generated client emits \`import { ... } from '${specifier}'\` into the ` +
        `output directory, so the specifier must resolve identically from anywhere in the ` +
        `consumer package. Use a package.json \`imports\` alias (\`'#schemas'\`) for ` +
        `same-package schemas, or a package specifier for a separate schemas package.`
    );
  }

  // The trampoline lives in the OUTPUT directory — a directory this plugin
  // already owns and writes generated files into — never in the consumer's
  // package root or node_modules. Two reasons this location is load-bearing:
  //
  //   - Node's package-scope lookup (LOOKUP_PACKAGE_SCOPE in the ESM
  //     resolution spec) walks up from the referrer and STOPS at any
  //     `node_modules` path segment, returning no scope — a module inside
  //     node_modules has no `imports` aliases at all. The output dir sits
  //     inside the consumer package, so the walk finds their package.json.
  //   - It is where the generated client's own import statements will
  //     execute from, so the audit's resolution is the consumer-runtime
  //     resolution by construction, not by convention.
  //
  // The `.mjs` extension keeps the trampoline ESM regardless of the
  // consumer's `type` field.
  await mkdir(outputDir, { recursive: true });
  const trampolinePath = join(
    outputDir,
    `.zod-to-openapi-heyapi-anchor-${process.pid}-${randomUUID()}.mjs`
  );
  await writeFile(trampolinePath, 'export const load = (s) => import(s);\n');
  try {
    const { load } = (await import(pathToFileURL(trampolinePath).href)) as {
      load: (s: string) => Promise<unknown>;
    };
    return (await load(specifier)) as Record<string, unknown>;
  } finally {
    await rm(trampolinePath, { force: true });
  }
}
