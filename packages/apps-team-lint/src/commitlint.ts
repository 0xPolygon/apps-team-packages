import type { UserConfig } from '@commitlint/types';

import conventional from '@commitlint/config-conventional';

const defaultTypes = conventional.rules['type-enum'][2] as string[];
const defaultPromptTypes = conventional.prompt.questions.type.enum;

export function commitlint(): UserConfig {
  return {
    extends: ['@commitlint/config-conventional'],
    rules: {
      // Extend the default types rather than replacing them, so future
      // updates to @commitlint/config-conventional are inherited automatically.
      'type-enum': [2, 'always', [...defaultTypes, 'release']]
    },
    prompt: {
      questions: {
        type: {
          enum: {
            ...defaultPromptTypes,
            release: {
              description: 'A version release commit created by changesets',
              title: 'Release',
              emoji: '🚢'
            }
          }
        }
      }
    }
  };
}
