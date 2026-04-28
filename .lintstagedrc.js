// This exists as a js file because .lintstagedrc w/ large #s of impacted files fails, but lintstagedrc.js works :)

// Codegen snapshots — these directories are emitted verbatim by hey-api and
// must stay byte-stable to act as a regression-detection signal. Reformatting
// them via eslint/prettier/markdownlint at lint-staged time would obscure
// real plugin-emit changes. ESLint and Prettier already honour their own
// ignore configs, but filtering here keeps the per-file commands clean and
// makes the intent obvious.
const isGenerated = (file) => file.includes('/test/__generated__/');
const notGenerated = (files) => files.filter((f) => !isGenerated(f));

export default {
  '*.{ts,cts,mts,tsx,js,cjs,mjs}': (files) => {
    const filtered = notGenerated(files);
    return filtered.length > 0
      ? [`eslint --fix ${filtered.join(' ')}`, `prettier --write ${filtered.join(' ')}`]
      : [];
  },
  '*.{json,yaml,yml}': (files) => {
    const filtered = notGenerated(files);
    return filtered.length > 0 ? `prettier --write ${filtered.join(' ')}` : [];
  },
  '*.md': (files) => {
    const filtered = notGenerated(files);
    return filtered.length > 0 ? `markdownlint-cli2 --fix ${filtered.join(' ')}` : [];
  },
  // zod-to-openapi-heyapi: any change to plugin source, fixtures, or codegen
  // entry refreshes the committed test/__generated__ snapshot and re-stages
  // the result. Mirrors the codegen-drift CI check — local enforcement so
  // contributors don't have to remember to run codegen by hand.
  'packages/zod-to-openapi-heyapi/{src,test/fixtures}/**/*.ts': () => [
    'pnpm --filter @polygonlabs/zod-to-openapi-heyapi run codegen',
    'git add packages/zod-to-openapi-heyapi/test/__generated__'
  ]
};
