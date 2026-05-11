import { recommended, typescript } from './src/index.ts';

export default [
  ...recommended({ globals: 'node' }),
  ...typescript({ tsconfigRootDir: import.meta.dirname }),
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      'import-x/no-named-as-default-member': 'off'
    }
  },
  {
    files: ['.markdownlint-cli2.mjs'],
    rules: {
      'import-x/no-default-export': 'off'
    }
  },
  { ignores: ['out-tsc/**'] }
];
