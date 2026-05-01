#!/usr/bin/env node
// Verifies that every entry point in package.json's `exports` map (a) exists
// as a file under dist/ and (b) resolves at runtime — every transitive import
// reaches a real file. Catches the "incremental tsc skipped a file" failure
// mode that broke the initial @polygonlabs/express npm publish: the build can
// succeed (typecheck + tsc both exit 0) while dist/ is missing the compiled
// output for a file that was newly added under src/, and the broken package
// only fails at consumer import time.
//
// Walks publishConfig.exports if present (that's the shape consumers see
// after publish), falling back to exports otherwise. For each export entry
// whose value references a file under ./dist/, asserts the file exists, then
// `await import()`s the entry point — that resolves the full transitive
// import graph, so a missing re-exported file (`export { x } from './y.ts'`
// where dist/y.js is absent) fails here, not at consumer install time.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cwd } from 'node:process';
import { pathToFileURL } from 'node:url';

const pkgPath = resolve(cwd(), 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const exportsMap = pkg.publishConfig?.exports ?? pkg.exports;

if (!exportsMap || typeof exportsMap !== 'object') {
  console.error(`verify-dist-exports: ${pkg.name} has no exports map; nothing to verify.`);
  process.exit(0);
}

/**
 * Collect every dist file referenced by the exports map. Each entry is the
 * `import` (or single-string) target — that's the JS the consumer's runtime
 * actually loads.
 */
function collectImportTargets(map) {
  const targets = [];
  for (const [subpath, conditionMap] of Object.entries(map)) {
    if (typeof conditionMap === 'string') {
      if (conditionMap.startsWith('./dist/')) {
        targets.push({ subpath, file: conditionMap });
      }
      continue;
    }
    if (typeof conditionMap !== 'object' || conditionMap === null) continue;
    const importTarget = conditionMap.import ?? conditionMap.default;
    if (typeof importTarget === 'string' && importTarget.startsWith('./dist/')) {
      targets.push({ subpath, file: importTarget });
    }
  }
  return targets;
}

const targets = collectImportTargets(exportsMap);

const failures = [];
for (const { subpath, file } of targets) {
  const absPath = resolve(cwd(), file);
  if (!existsSync(absPath)) {
    failures.push({ subpath, file, reason: 'missing-file' });
    continue;
  }
  // Resolve the full import graph by loading it. A missing transitive
  // re-export ("Cannot find module './notFound.js'") throws here.
  try {
    await import(pathToFileURL(absPath).href);
  } catch (err) {
    failures.push({
      subpath,
      file,
      reason: 'import-failed',
      message: err instanceof Error ? err.message : String(err)
    });
  }
}

if (failures.length > 0) {
  const lines = failures.map((f) => {
    if (f.reason === 'missing-file') {
      return `  ${f.subpath} → ${f.file} (file not found)`;
    }
    return `  ${f.subpath} → ${f.file} (import failed: ${f.message})`;
  });
  console.error(
    `verify-dist-exports: ${pkg.name}'s built dist/ is incomplete or unloadable.\n` +
      `This is the "incremental tsc skipped a file" failure mode — clean dist/ +\n` +
      `*.tsbuildinfo and rebuild. Failures:\n` +
      lines.join('\n')
  );
  process.exit(1);
}

console.log(`verify-dist-exports: ${pkg.name} — ${targets.length} entry point(s) load cleanly.`);
