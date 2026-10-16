/**
 * Config-level test for the `export *` ban in `recommended()`. Lints through
 * the real `ESLint` class so the composed config is what is exercised.
 */

import type { Linter } from 'eslint';

import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import { recommended, typescript } from '../src/index.ts';

const filePath = resolve(import.meta.dirname, 'fixtures/placeholder.ts');

async function ruleIdsFor(code: string) {
  const overrideConfig = [
    ...recommended(),
    ...typescript({ tsconfigRootDir: resolve(import.meta.dirname, 'fixtures') })
  ] as Linter.Config[];
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig });
  const results = await eslint.lintText(code, { filePath });
  return results
    .flatMap((result) => result.messages)
    .map((message) => message.ruleId ?? message.message);
}

describe('export-star ban', () => {
  it('flags `export * from`', async () => {
    expect(await ruleIdsFor("export * from './x.ts';\n")).to.include('no-restricted-syntax');
  });

  it('flags `export * as ns from`', async () => {
    expect(await ruleIdsFor("export * as ns from './x.ts';\n")).to.include('no-restricted-syntax');
  });

  it('allows explicit re-exports', async () => {
    const ids = await ruleIdsFor("export { a } from './x.ts';\nexport type { B } from './x.ts';\n");
    expect(ids).to.not.include('no-restricted-syntax');
  });
});
