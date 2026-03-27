/**
 * Type-level tests. Checked by `tsc --noEmit` (`pnpm typecheck`), never executed.
 *
 * Each `@ts-expect-error` asserts that the following line IS a type error.
 * TypeScript will itself error if a `@ts-expect-error` is unused — i.e. if the
 * annotated line turns out NOT to be an error — making these bidirectional guards.
 */

import type { Logger } from 'pino';

declare const logger: Logger;

// ── child() return type ──────────────────────────────────────────────────────

const child: Logger = logger.child({ component: 'test' });
void child;

const grandchild: Logger = logger.child({ a: 1 }).child({ b: 2 });
void grandchild;

const great: Logger = logger.child({ a: 1 }).child({ b: 2 }).child({ c: 3 });
void great;
