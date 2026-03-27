import type { Linter } from 'eslint';

import prettierConfig from 'eslint-config-prettier';
import { flatConfigs as importXConfigs } from 'eslint-plugin-import-x';
import perfectionist from 'eslint-plugin-perfectionist';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';

import { allCodeFiles, internalPattern } from './constants.ts';

export interface RecommendedOptions {
  globals?: 'node' | 'browser' | Record<string, boolean>;
}

export function recommended(options?: RecommendedOptions) {
  const globalsConfig: Linter.Config[] = [];

  if (options?.globals) {
    const resolvedGlobals =
      typeof options.globals === 'string' ? globals[options.globals] : options.globals;

    globalsConfig.push({
      name: '@polygonlabs/apps-team-lint/globals',
      files: [allCodeFiles],
      languageOptions: {
        globals: { ...resolvedGlobals }
      }
    });
  }

  return defineConfig([
    globalIgnores(['**/dist']),
    {
      name: '@polygonlabs/apps-team-lint/import-sorting',
      files: [allCodeFiles],
      plugins: {
        perfectionist
      },
      rules: {
        'perfectionist/sort-imports': [
          'error',
          {
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
          }
        ]
      }
    },
    {
      name: '@polygonlabs/apps-team-lint/import-x-recommended',
      files: [allCodeFiles],
      ...importXConfigs.recommended
    },
    {
      name: '@polygonlabs/apps-team-lint/core-rules',
      files: [allCodeFiles],
      settings: {
        'import/internal-regex': internalPattern
      },
      rules: {
        'import-x/consistent-type-specifier-style': ['error', 'prefer-top-level'],
        'import-x/no-duplicates': ['error'],
        'import-x/no-default-export': 'error',
        'import-x/no-extraneous-dependencies': ['off'],
        'import-x/no-relative-packages': ['error'],
        'import-x/no-unresolved': ['off'],
        'import-x/prefer-default-export': ['off'],
        'no-await-in-loop': 'off',
        'no-param-reassign': 'error',
        'no-underscore-dangle': ['off'],
        'no-useless-escape': 'off'
      }
    },
    {
      name: '@polygonlabs/apps-team-lint/config-file-exemptions',
      files: [
        '**/*.config.{js,ts,mjs}',
        '**/*.config.*.{js,ts,mjs}',
        '**/.lintstagedrc.{js,ts,mjs}',
        '**/.markdownlint-cli2.{js,cjs,mjs}',
        '**/worker.{js,ts,mjs}'
      ],
      rules: {
        'import-x/no-default-export': 'off'
      }
    },
    {
      name: '@polygonlabs/apps-team-lint/prettier',
      ...prettierConfig
    },
    ...globalsConfig
  ]);
}
