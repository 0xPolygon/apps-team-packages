/**
 * Type-level tests. Checked by `tsc --noEmit` (`pnpm typecheck`), never executed.
 *
 * Each `@ts-expect-error` asserts that the following line IS a type error.
 * TypeScript will itself error if a `@ts-expect-error` is unused — i.e. if the
 * annotated line turns out NOT to be an error — making these bidirectional guards.
 */

import type { AppLogger } from '../src/logger.ts';

declare const logger: AppLogger;
declare const err: Error;

// ── logError call signature ──────────────────────────────────────────────────

// @ts-expect-error err is required in the context object
logger.logError({});

// @ts-expect-error cannot pass an Error directly — must be wrapped in { err }
logger.logError(err);

// @ts-expect-error error_info is a reserved key — passing it is a type error
logger.logError({ err, error_info: { foo: 'bar' } });

// valid forms
logger.logError({ err });
logger.logError({ err, requestId: 'abc' });
logger.logError({ err, userId: 42, requestId: 'xyz' });
logger.logError({ err }, 'message override');
logger.logError({ err, requestId: 'abc' }, 'override');

// err must be an Error instance — non-Error values are rejected
// @ts-expect-error err must be an Error, not a string
logger.logError({ err: 'plain string' });
// @ts-expect-error err must be an Error, not a number
logger.logError({ err: 42 });
// @ts-expect-error err must be an Error, not undefined
logger.logError({ err: undefined });
// @ts-expect-error err must be an Error, not null
logger.logError({ err: null });

// ── child() return type ──────────────────────────────────────────────────────

// child() returns AppLogger, not plain pino.Logger — logError is preserved
const child: AppLogger = logger.child({ component: 'test' });
void child;

// @ts-expect-error child's logError has the same error_info reserved-key constraint
child.logError({ err, error_info: { x: 1 } });

// valid child usage
child.logError({ err });
child.logError({ err, requestId: 'abc' });

// grandchild is also AppLogger
const grandchild: AppLogger = logger.child({ a: 1 }).child({ b: 2 });
void grandchild;

grandchild.logError({ err });
// @ts-expect-error error_info is reserved at every depth of the logger hierarchy
grandchild.logError({ err, error_info: {} });
