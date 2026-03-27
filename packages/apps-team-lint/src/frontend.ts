import { defineConfig } from 'eslint/config';

export function frontend() {
  return defineConfig([
    {
      name: '@polygonlabs/apps-team-lint/tsx-default-export',
      files: ['**/*.tsx'],
      rules: {
        'import-x/no-default-export': 'off'
      }
    }
  ]);
}
