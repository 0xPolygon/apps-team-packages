// Unit tests for the published error helpers.
//
// The codegen-emitted guards and classes are tested end-to-end via
// `api-errors.test.ts` (real MSW request flows) and
// `hooks.browser.test.tsx` (real Chromium hook integration). This
// file covers the cross-client structural surface in `src/errors.ts`
// — the helpers consumers import as
// `import { categorizeApiError } from '@polygonlabs/zod-to-openapi-heyapi/errors'`.
//
// Key contract: the error helpers operate on values from ANY
// generated client (or fabricated test inputs), discriminating
// purely via the symbol-keyed markers — never `instanceof`. Tests
// fabricate inputs without touching the codegen fixture so the
// surface is pinned independently of any particular generated
// client.

import { describe, expect, it } from 'vitest';

import {
  TRANSPORT_ERROR_MARKER,
  RESPONSE_VALIDATION_ERROR_MARKER,
  categorizeApiError,
  getApiErrorMessage,
  isTransportError,
  isResponseValidationError,
  isWrapperError
} from '../src/errors.ts';

// ── Test fixtures ────────────────────────────────────────────────────────────

/**
 * Fabricates a value with the same structural shape the wrapper
 * produces: an `Error` subclass carrying the symbol marker. The
 * runtime guards check the marker, never the class identity, so
 * these fixtures are interchangeable with values produced by a
 * generated client at runtime.
 *
 * `cause` and `body` are attached via `Object.assign` rather than
 * the 2-arg `Error` constructor so the fixture compiles under any
 * TS lib target — the 2-arg form is ES2022 and not all `lib`
 * configs widen the constructor signature.
 */
function makeTransport(cause: Error): Error {
  const err = Object.assign(new Error('Request failed before producing an HTTP response'), {
    cause
  });
  (err as unknown as Record<symbol, unknown>)[TRANSPORT_ERROR_MARKER] = true;
  return err;
}

function makeResponseValidation(issues: ReadonlyArray<unknown>, body: unknown): Error {
  const cause = Object.assign(new Error('zod parse failed'), { issues });
  const err = Object.assign(new Error('API response did not match the registered schema'), {
    cause,
    body
  });
  (err as unknown as Record<symbol, unknown>)[RESPONSE_VALIDATION_ERROR_MARKER] = true;
  return err;
}

// ── Type-predicate guards ────────────────────────────────────────────────────

describe('isTransportError', () => {
  it('returns true for values carrying the transport marker', () => {
    const err = makeTransport(new TypeError('fetch failed'));
    expect(isTransportError(err)).toBe(true);
  });

  it('narrows to TransportError so .cause is accessible without a cast', () => {
    const fetchError = new TypeError('fetch failed');
    const err = makeTransport(fetchError);
    if (isTransportError(err)) {
      // `err.cause` is typed as `Error` by the predicate. No cast.
      expect(err.cause).toBe(fetchError);
    } else {
      throw new Error('guard should have fired');
    }
  });

  it('returns false for an ResponseValidationError (mutual exclusion)', () => {
    const err = makeResponseValidation([], { wire: 'shape' });
    expect(isTransportError(err)).toBe(false);
  });

  it('returns false for a native Error without our marker', () => {
    expect(isTransportError(new TypeError('vanilla'))).toBe(false);
  });

  it('returns false for any non-object value', () => {
    for (const v of [null, undefined, '', 'string', 0, 1, false, true, [], () => null]) {
      expect(isTransportError(v)).toBe(false);
    }
  });
});

describe('isResponseValidationError', () => {
  it('returns true for values carrying the response-validation marker', () => {
    const err = makeResponseValidation([{ path: ['x'], code: 'invalid_type' }], { wire: 'shape' });
    expect(isResponseValidationError(err)).toBe(true);
  });

  it('narrows to ResponseValidationError so .cause.issues and .body are accessible without a cast', () => {
    const issues = [{ path: ['code'], code: 'invalid_type' }] as const;
    const body = { unexpected: 'shape' };
    const err = makeResponseValidation(issues, body);
    if (isResponseValidationError(err)) {
      // Both fields are typed by the predicate. No cast.
      expect(err.cause.issues).toEqual(issues);
      expect(err.body).toEqual(body);
    } else {
      throw new Error('guard should have fired');
    }
  });

  it('returns false for a TransportError (mutual exclusion)', () => {
    const err = makeTransport(new TypeError('fetch failed'));
    expect(isResponseValidationError(err)).toBe(false);
  });

  it('returns false for a typed-error shape', () => {
    const typed = { code: 'not_found', message: 'no resource' };
    expect(isResponseValidationError(typed)).toBe(false);
  });
});

describe('isWrapperError', () => {
  it('returns true for transport AND response-validation wrapper errors', () => {
    expect(isWrapperError(makeTransport(new Error('x')))).toBe(true);
    expect(isWrapperError(makeResponseValidation([], {}))).toBe(true);
  });

  it('returns false for native Errors and typed-error shapes', () => {
    expect(isWrapperError(new TypeError('vanilla'))).toBe(false);
    expect(isWrapperError({ code: 'x', message: 'y' })).toBe(false);
  });
});

// ── categorizeApiError ──────────────────────────────────────────────────────

describe('categorizeApiError', () => {
  it('routes a TransportError to kind=transport with full narrowing', () => {
    const cause = new TypeError('fetch failed');
    const err = makeTransport(cause);
    const category = categorizeApiError(err);
    expect(category.kind).toBe('transport');
    if (category.kind === 'transport') {
      // `category.error` is `TransportError`; `.cause` is `Error`.
      // Discriminated union narrows automatically.
      expect(category.error.cause).toBe(cause);
    }
  });

  it('routes a ResponseValidationError to kind=response-validation with full narrowing', () => {
    const issues = [{ path: ['x'], code: 'invalid_type' }] as const;
    const body = { unexpected: 'shape' };
    const err = makeResponseValidation(issues, body);
    const category = categorizeApiError(err);
    expect(category.kind).toBe('response-validation');
    if (category.kind === 'response-validation') {
      expect(category.error.cause.issues).toEqual(issues);
      expect(category.error.body).toEqual(body);
    }
  });

  it('routes a native Error (no marker) to kind=native-error', () => {
    // Non-wrapper code paths land here — most commonly the codec-
    // aware TanStack Query factory's `queryFn` rejecting with a raw
    // native Error from the SDK's `throwOnError: true`.
    const err = new TypeError('signal aborted');
    const category = categorizeApiError(err);
    expect(category.kind).toBe('native-error');
    if (category.kind === 'native-error') {
      expect(category.error).toBe(err);
    }
  });

  it('routes a typed-error shape (or anything non-Error) to kind=other', () => {
    // The runtime helper deliberately does NOT invent a 'typed'
    // category: the consumer's wrapper return is already statically
    // narrowed to `${Op}Error | TransportError | ResponseValidationError | undefined`,
    // so once the wrapper-error branches are peeled off via the
    // emitted guards, the static type IS the typed `${Op}Error`. The
    // helper would only obscure that. For code paths that don't
    // have the typed return in scope (logging adapters, etc.), the
    // 'other' branch carries the value as `unknown` so consumers can
    // narrow with their per-op types — never a magic-string
    // convention here.
    const typed = { code: 'not_found', message: 'no resource' };
    const category = categorizeApiError(typed);
    expect(category.kind).toBe('other');
    if (category.kind === 'other') {
      expect(category.error).toBe(typed);
    }
  });

  it('routes an unrecognised shape to kind=other (same bucket — runtime helper does no schema check)', () => {
    const noise = { random: 'shape', not: 42 };
    const category = categorizeApiError(noise);
    expect(category.kind).toBe('other');
  });

  it('routes null and primitives to kind=other', () => {
    for (const v of [null, undefined, 0, '', false, []]) {
      expect(categorizeApiError(v).kind).toBe('other');
    }
  });

  it('preserves wrapper-error precedence over instanceof Error', () => {
    // Both makeTransport and makeResponseValidation produce values that are
    // ALSO `instanceof Error` (we built them from `new Error(...)`).
    // The categoriser must check the marker first — otherwise every
    // wrapper-error would route to kind=native-error and the typed-
    // error / wire-body fields would be invisible.
    expect(makeTransport(new Error('x')) instanceof Error).toBe(true);
    expect(categorizeApiError(makeTransport(new Error('x'))).kind).toBe('transport');
    expect(makeResponseValidation([], {}) instanceof Error).toBe(true);
    expect(categorizeApiError(makeResponseValidation([], {})).kind).toBe('response-validation');
  });
});

// ── getApiErrorMessage ──────────────────────────────────────────────────────

describe('getApiErrorMessage', () => {
  it('returns the wrapper-error super message for transport errors', () => {
    const err = makeTransport(new TypeError('fetch failed'));
    expect(getApiErrorMessage(err)).toBe('Request failed before producing an HTTP response');
  });

  it('returns the wrapper-error super message for response-validation errors', () => {
    const err = makeResponseValidation([], {});
    expect(getApiErrorMessage(err)).toBe('API response did not match the registered schema');
  });

  it('returns the message field of a native Error', () => {
    expect(getApiErrorMessage(new TypeError('signal aborted'))).toBe('signal aborted');
  });

  it('falls back for typed-error shapes (helper relies on Error.message, never invents one)', () => {
    // The runtime helper doesn't pretend to know typed-error
    // conventions. A consumer with the typed `${Op}Error` in scope
    // reads `error.message` directly off the typed return type;
    // this helper is for code paths without that type information.
    expect(getApiErrorMessage({ code: 'not_found', message: 'no resource' }, 'fallback')).toBe(
      'fallback'
    );
  });

  it('falls back when the value has no usable message', () => {
    expect(getApiErrorMessage(null)).toBe('Unknown error');
    expect(getApiErrorMessage(undefined, 'oops')).toBe('oops');
    expect(getApiErrorMessage({ random: 'shape' }, 'oops')).toBe('oops');
  });

  it('falls back when Error.message is the empty string', () => {
    // Empty `message` shouldn't surface to the user — fall back to
    // the configured copy.
    expect(getApiErrorMessage(new Error(''), 'oops')).toBe('oops');
  });
});

// ── Symbol-key constants ─────────────────────────────────────────────────────

describe('symbol-key constants', () => {
  it('TRANSPORT_ERROR_MARKER and RESPONSE_VALIDATION_ERROR_MARKER are distinct global symbols', () => {
    expect(TRANSPORT_ERROR_MARKER).not.toBe(RESPONSE_VALIDATION_ERROR_MARKER);
  });

  it('markers === Symbol.for(canonical key) so cross-realm narrowing works', () => {
    // The codegen emits classes that set this same key in their
    // constructors. If a consumer hand-builds a marker check using
    // Symbol.for(...) with the canonical string, it MUST match the
    // exported constant — otherwise narrowing splits across the
    // boundary.
    expect(TRANSPORT_ERROR_MARKER).toBe(
      Symbol.for('@polygonlabs/zod-to-openapi-heyapi/is-transport-error')
    );
    expect(RESPONSE_VALIDATION_ERROR_MARKER).toBe(
      Symbol.for('@polygonlabs/zod-to-openapi-heyapi/is-response-validation-error')
    );
  });
});
