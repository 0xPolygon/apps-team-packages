import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import { flatConfigs as importXConfigs } from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

import { tsFiles } from './constants.ts';
import { polygonPlugin } from './plugin.ts';

export interface TypeScriptOptions {
  tsconfigRootDir?: string;
}

export function typescript(options?: TypeScriptOptions) {
  return tseslint.config({
    files: [tsFiles],
    extends: [
      tseslint.configs.eslintRecommended,
      ...tseslint.configs.recommended,
      importXConfigs.typescript
    ],
    plugins: {
      polygon: polygonPlugin
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        ...(options?.tsconfigRootDir != null ? { tsconfigRootDir: options.tsconfigRootDir } : {})
      }
    },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver()]
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error'],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      // Catches the partial-discard case in @polygonlabs/openapi-registry's
      // chainable API that the type-level `OperationsOf` brand can't detect.
      // See @polygonlabs/apps-team-lint/src/rules/no-discarded-chain.ts.
      'polygon/no-discarded-chain': 'error'
    }
  });
}
