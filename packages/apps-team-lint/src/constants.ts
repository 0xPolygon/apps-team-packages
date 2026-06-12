export const internalPattern = '^@(polygonlabs|maticnetwork|agglayer|0xsequence|0xtrails)/';

export const allCodeFiles = '**/*.{ts,tsx,js,jsx,mjs,cjs}';
export const tsFiles = '**/*.{ts,tsx}';

// `.astro` frontmatter (the `---` fenced module) is matched directly; the
// component's client-side `<script>` blocks are exposed by the Astro processor
// as virtual files under a `<name>.astro/` path with a `.js`/`.ts` extension.
export const astroFiles = '**/*.astro';
export const astroScriptFiles = ['**/*.astro/*.js', '**/*.astro/*.ts'];

// Shared import-sorting options. `recommended()` applies these to all code
// files and `astro()` reuses the exact same object for `.astro` frontmatter,
// so the two can never drift apart.
export const sortImportsOptions = {
  type: 'natural',
  internalPattern: [internalPattern],
  groups: [
    'type-import',
    'value-builtin',
    'value-external',
    'type-internal',
    'value-internal',
    ['type-parent', 'type-sibling', 'type-index'],
    ['value-parent', 'value-sibling', 'value-index'],
    'ts-equals-import',
    'unknown'
  ]
};
