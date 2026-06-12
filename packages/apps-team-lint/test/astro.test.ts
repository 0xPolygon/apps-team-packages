/**
 * Config-level tests for the `astro()` export.
 *
 * Unlike the rule-unit test (`no-discarded-typed-registry-chain.test.ts`,
 * which drives a single rule via `RuleTester`), these tests exercise the whole
 * composed flat config — `recommended()` + `typescript()` + `astro()` — the way
 * a consumer's `eslint.config.js` does. We lint `.astro` source strings through
 * the real `ESLint` class so the Astro parser and its `<script>`-extracting
 * processor run exactly as they will in a repo. `lintText` ignores paths
 * outside the cwd, so every fixture is given a `filePath` under this package.
 */

import type { Linter } from 'eslint';

import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import type { AstroOptions } from '../src/astro.ts';

import { astro } from '../src/astro.ts';
import { recommended, typescript } from '../src/index.ts';

const fixturePath = resolve(import.meta.dirname, 'fixture.astro');

function lintAstro(code: string, options?: AstroOptions) {
  // `recommended()`/`typescript()`/`astro()` each return arrays typed by their
  // own ESLint-config flavour (eslint/config vs typescript-eslint), which carry
  // structurally-divergent `Config` types; flatten to the `eslint` package's
  // own `Linter.Config[]` at this single boundary so the composed array fits
  // the `ESLint` constructor.
  const overrideConfig = [
    ...recommended({ globals: 'browser' }),
    ...typescript(),
    ...astro(options)
  ] as Linter.Config[];
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig });
  return eslint.lintText(code, { filePath: fixturePath });
}

async function ruleIdsFor(code: string, options?: AstroOptions) {
  const results = await lintAstro(code, options);
  return results.flatMap((result) => result.messages).map((message) => message.ruleId);
}

describe('astro()', () => {
  it('catches a team-rule violation in the frontmatter', async () => {
    // Out-of-order + duplicate imports in the `---` frontmatter block. These
    // are the rules astro() extends onto `.astro` (recommended()/typescript()
    // scope them to globs that skip the frontmatter).
    const ruleIds = await ruleIdsFor(`---
import { z } from './z.js';
import { a } from './a.js';
import { b } from './a.js';
---
<p>{a}{b}{z}</p>
`);

    expect(ruleIds).to.include('perfectionist/sort-imports');
    expect(ruleIds).to.include('import-x/no-duplicates');
  });

  it('parses a typed frontmatter without a fatal error', async () => {
    // Astro frontmatter is TypeScript; type syntax must not be a parse error.
    const results = await lintAstro(`---
interface Props {
  id: string;
}
const { id }: Props = Astro.props;
---
<p>{id}</p>
`);
    const fatals = results.flatMap((result) => result.messages).filter((message) => message.fatal);

    expect(fatals).to.have.lengthOf(0);
  });

  it('catches a team-rule violation inside a client <script> block', async () => {
    // The Astro processor extracts `<script>` content into a virtual file that
    // our core import rules match — so duplicate imports are caught there too.
    // This also pins the type-aware reset: this module `<script>` becomes a
    // `.ts` virtual, which would otherwise crash the type-aware rules.
    const ruleIds = await ruleIdsFor(`---
const value = 1;
---
<p>{value}</p>
<script>
import { b } from './module.js';
import { a } from './module.js';
console.log(a, b);
</script>
`);

    expect(ruleIds).to.include('import-x/no-duplicates');
  });

  it('lints TypeScript inside an inline <script> and catches a violation there', async () => {
    // Inline `<script>` with TypeScript is Astro's first-class, documented
    // pattern; the client-side-ts processor must parse the type syntax (no
    // fatal) and still apply the team's rules (duplicate import caught here).
    const results = await lintAstro(`---
const ready = true;
---
<button id="run" data-ready={ready}>Run</button>
<script>
import { setup } from './setup.js';
import { setup as setupAgain } from './setup.js';
const el: HTMLElement | null = document.getElementById('run');
el?.addEventListener('click', () => setup(setupAgain));
</script>
`);
    const messages = results.flatMap((result) => result.messages);
    const ruleIds = messages.map((message) => message.ruleId);

    expect(messages.filter((message) => message.fatal)).to.have.lengthOf(0);
    expect(ruleIds).to.include('import-x/no-duplicates');
  });

  it('catches an accessibility violation in the template (a11y default-on)', async () => {
    const ruleIds = await ruleIdsFor(`---
const source = '/logo.png';
---
<img src={source} />
`);

    expect(ruleIds).to.include('astro/jsx-a11y/alt-text');
  });

  it('flags a set:html directive as a security error', async () => {
    const ruleIds = await ruleIdsFor(`---
const markup = '<b>hi</b>';
---
<div set:html={markup}></div>
`);

    expect(ruleIds).to.include('astro/no-set-html-directive');
  });

  it('does not load the a11y ruleset when a11y is disabled', async () => {
    const ruleIds = await ruleIdsFor(
      `---
const source = '/logo.png';
---
<img src={source} />
`,
      { a11y: false }
    );

    expect(ruleIds).to.not.include('astro/jsx-a11y/alt-text');
  });

  it('passes a well-formed file with an inline JS <script>', async () => {
    // Pins the processor + rule choices: a plain-JS inline `<script>` lints
    // cleanly (we don't enable `no-unsafe-inline-scripts`, and the type-aware
    // reset stops the script's `.ts` virtual file from crashing the type-aware
    // rules). Client TypeScript belongs in external `.ts` modules, not inline.
    const results = await lintAstro(`---
import { renderGraph } from './graph.js';
---
<button id="run">Run</button>
<script>
import { renderGraph } from './graph.js';
renderGraph(document.getElementById('run'));
</script>
`);
    const messages = results.flatMap((result) => result.messages);

    expect(messages).to.have.lengthOf(0);
  });
});
