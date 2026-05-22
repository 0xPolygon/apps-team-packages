/**
 * Type-level tests. Checked by `tsc --noEmit` (`pnpm typecheck`), never executed.
 *
 * Each `@ts-expect-error` asserts that the following line IS a type error.
 * TypeScript will itself error if a `@ts-expect-error` is unused — i.e. if the
 * annotated line turns out NOT to be an error — making these bidirectional guards.
 */

import {
  VError,
  WError,
  MultiError,
  HTTPError,
  BadRequest,
  NotFound,
  serializeError,
  findCauseByType,
  findCauseByName,
  cause,
  info,
  fullStack
} from '../src/index.ts';

// ── VError constructor ──────────────────────────────────────────────────────

// @ts-expect-error message is required
new VError();

// @ts-expect-error message must be a string, not a number
new VError(42);

// @ts-expect-error cause must be an Error, not an arbitrary value
new VError('msg', { cause: 'not an error' });

// @ts-expect-error name is not part of VErrorOptions — no per-instance naming
new VError('msg', { name: 'Custom' });

// valid forms
new VError('msg');
new VError('msg', {});
new VError('msg', { cause: new Error() });
new VError('msg', { cause: new VError('inner') });
new VError('msg', { info: { key: 'val' } });
new VError('msg', { cause: new Error(), info: { k: 1 } });

// ── WError constructor ──────────────────────────────────────────────────────

// WError exists to wrap a cause. The constructor signature narrows
// `VErrorOptions` to require `cause: Error` so the type system surfaces a
// "you didn't wrap anything" mistake at the call site. The runtime W-semantics
// (suppress cause-message accumulation) come from `WERROR_SYMBOL` on the
// prototype.

// @ts-expect-error options are required because cause is mandatory
new WError('msg');

// @ts-expect-error cause is required even when options object is present
new WError('msg', {});

// @ts-expect-error cause must be an Error, not an arbitrary value
new WError('msg', { cause: 'not an error' });

// @ts-expect-error skipCauseMessage has been removed from VErrorOptions
new WError('msg', { cause: new Error(), skipCauseMessage: true });

// valid forms
new WError('msg', { cause: new Error() });
new WError('msg', { cause: new VError('inner') });
new WError('msg', { cause: new Error(), info: { k: 1 } });

// ── Static helper return types ──────────────────────────────────────────────

// cause() returns Error | null
const _cause: Error | null = cause(new VError('test'));
void _cause;

// @ts-expect-error cause() requires an Error argument, not an arbitrary value
cause('not an error');

// info() returns Record<string, unknown>
const _info: Record<string, unknown> = info(new VError('test'));
void _info;

// fullStack returns string
const _stack: string = fullStack(new Error('test'));
void _stack;

// serializeError accepts unknown, returns Record<string, unknown> | undefined
const _ser: Record<string, unknown> | undefined = serializeError(new Error('test'));
void _ser;
serializeError(undefined);
serializeError('a string');
serializeError(42);

// ── findCause* generic inference ────────────────────────────────────────────

// findCauseByType infers T from the type argument — result is T | null
const _foundBadReq: BadRequest | null = findCauseByType(new VError('test'), BadRequest);
void _foundBadReq;

const _foundNotFound: NotFound | null = findCauseByType(new VError('test'), NotFound);
void _foundNotFound;

// findCauseByName returns Error | null (name matching is runtime, not type-narrowing)
const _byName: Error | null = findCauseByName(new VError('test'), 'BadRequest');
void _byName;

// ── HTTP error literal statusCode types ─────────────────────────────────────

const badReq = new BadRequest('test');

// statusCode is a literal type on concrete subclasses (400 as const)
const _badReqCode: 400 = badReq.statusCode;
void _badReqCode;

// name is a literal type on concrete subclasses ('BadRequest' as const)
const _badReqName: 'BadRequest' = badReq.name;
void _badReqName;

const notFound = new NotFound('test');
const _notFoundCode: 404 = notFound.statusCode;
void _notFoundCode;

// HTTPError base class exposes number (not a literal) — no statusCode value defined
const httpErr = new HTTPError('test');
const _httpCode: number = httpErr.statusCode;
void _httpCode;

// ── VError base class name type ─────────────────────────────────────────────

// VError.name is typed as string (explicit annotation on the base) so subclasses
// can narrow with `as const`. It is NOT the literal 'VError'.
const verr = new VError('test');
const _verrName: string = verr.name;
void _verrName;

// ── User-defined subclasses ──────────────────────────────────────────────────

class DatabaseError extends VError {
  override readonly name = 'DatabaseError' as const;
}

const dbErr = new DatabaseError('test');

// User-defined subclass name is a string literal
const _dbName: 'DatabaseError' = dbErr.name;
void _dbName;

// Still instanceof VError
const _isVError: boolean = dbErr instanceof VError;
void _isVError;

// ── MultiError ──────────────────────────────────────────────────────────────

const multi = new MultiError([new Error('a'), new Error('b')]);

// errors is readonly
const _errors: readonly Error[] = multi.errors;
void _errors;

// @ts-expect-error MultiError items must be Errors, not plain strings
new MultiError(['not', 'errors']);
