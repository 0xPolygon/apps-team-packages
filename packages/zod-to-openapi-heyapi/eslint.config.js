import { defineConfig } from 'eslint/config';

import { recommended, typescript } from '@polygonlabs/apps-team-lint';

export default defineConfig([
  ...recommended({ globals: 'node' }),
  ...typescript({ tsconfigRootDir: import.meta.dirname }),
  { ignores: ['dist/**', 'test/__generated__/**'] },
  { ignores: ['out-tsc/**'] }
]);
