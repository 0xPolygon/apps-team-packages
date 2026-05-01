/**
 * `@polygonlabs/apps-team-lint`'s ESLint plugin object — the value ESLint's
 * flat config registers under the `polygon` namespace. Rules are referenced
 * downstream as `polygon/<rule-name>`.
 *
 * Currently houses one rule, `no-discarded-chain`, which catches the
 * partial-discard case of the @polygonlabs/openapi-registry chainable API
 * that the type-level `OperationsOf` brand cannot detect.
 */

import { noDiscardedChain } from './rules/no-discarded-chain.ts';

export const polygonPlugin = {
  meta: {
    name: '@polygonlabs/apps-team-lint',
    version: '2.0.2'
  },
  rules: {
    'no-discarded-chain': noDiscardedChain
  }
};
