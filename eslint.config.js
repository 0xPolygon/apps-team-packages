import { defineConfig } from 'eslint/config';

import { recommended, typescript } from '@polygonlabs/apps-team-lint';

export default defineConfig([
  ...recommended({ globals: 'node' }),
  ...typescript(),
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // Typecheck for these packages has custom type verification tests that rely on @ts-expect-error; ensure those clauses are always commented.
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': 'allow-with-description',
          minimumDescriptionLength: 10
        }
      ]
    }
  },
  { ignores: ['.claude/**', '**/dist/**'] }
]);
