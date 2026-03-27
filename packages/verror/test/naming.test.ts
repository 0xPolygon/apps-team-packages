/**
 * Tests for the class-level name convention and findCauseByName.
 *
 * Error names are a class-level concern, not a per-instance option.
 *
 * Preferred pattern — override the name field in the class body:
 *
 *   class DatabaseError extends VError {
 *     override readonly name = 'DatabaseError';
 *   }
 *
 * The string literal is minification-safe (minifiers mangle identifiers, not
 * string values).  This creates one own property per instance rather than a
 * single prototype property, which is negligible for error objects.
 *
 * Alternative for prototype-purists or hot paths:
 *
 *   class DatabaseError extends VError {}
 *   DatabaseError.prototype.name = 'DatabaseError';
 *
 * findCauseByName exists because prototype identity is unreliable in scenarios
 * where errors cross module boundaries: different versions of the same package
 * can be installed simultaneously (e.g. via nested node_modules), and
 * serialised/deserialised errors lose their prototype chain entirely.  In those
 * cases, checking the `name` string is the only reliable discriminant.
 */

import { describe, expect, it } from 'vitest';

import { VError, WError, findCauseByName, findCauseByType } from '../src/index.ts';

// ── Preferred pattern: override readonly name field ──────────────────────────

class DatabaseError extends VError {
  override readonly name = 'DatabaseError' as const;
}

class NetworkError extends WError {
  override readonly name = 'NetworkError' as const;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('name is a class-level property', () => {
  it('built-in classes have their names set on the prototype', () => {
    expect(new VError('test').name).toBe('VError');
    expect(new WError('test', { cause: new Error('root') }).name).toBe('WError');
  });

  it('override readonly name field — preferred TypeScript pattern', () => {
    const err = new DatabaseError('connection failed');
    expect(err.name).toBe('DatabaseError');
    expect(err).toBeInstanceOf(VError);
    expect(err).toBeInstanceOf(DatabaseError);
  });

  it('WError subclass uses the same pattern', () => {
    const err = new NetworkError('timeout', { cause: new Error('ECONNRESET') });
    expect(err.name).toBe('NetworkError');
    expect(err).toBeInstanceOf(WError);
    expect(err).toBeInstanceOf(VError);
  });

  it('without a name declaration, subclass inherits the parent name', () => {
    // Expected failure mode — immediately visible in development logs.
    class UnnamedError extends VError {}
    expect(new UnnamedError('test').name).toBe('VError');
  });

  it('without override readonly name, subclass instances show the parent name', () => {
    // VError's class field sets name = 'VError' on every instance as an own
    // property — there is no fallback to constructor.name.  Forgetting to
    // declare the name field is immediately visible in logs as the parent name.
    class UnnamedError extends VError {}
    expect(new UnnamedError('boom').name).toBe('VError');
    expect(new UnnamedError('boom').toString()).toBe('VError: boom');
  });
});

describe('findCauseByName — cross-boundary name matching', () => {
  it('finds a named subclass in the cause chain', () => {
    const root = new DatabaseError('connection failed');
    const wrapper = new VError('query failed', { cause: root });
    expect(findCauseByName(wrapper, 'DatabaseError')).toBe(root);
  });

  it('returns null when the name is not in the chain', () => {
    expect(findCauseByName(new VError('test'), 'DatabaseError')).toBeNull();
  });

  it('findCauseByName vs findCauseByType — both work when prototypes are intact', () => {
    const root = new DatabaseError('connection failed');
    const wrapper = new VError('query failed', { cause: root });
    expect(findCauseByType(wrapper, DatabaseError)).toBe(root);
    expect(findCauseByName(wrapper, 'DatabaseError')).toBe(root);
  });

  it('findCauseByName succeeds after prototype is lost (simulating deserialization)', () => {
    const root = new DatabaseError('connection failed');

    // Simulate a deserialised error: same shape, but prototype chain is plain Error.
    const deserialised = Object.assign(new Error(root.message), {
      name: 'DatabaseError'
    });
    const wrapper = new VError('query failed', { cause: deserialised });

    // findCauseByType fails — instanceof check fails on a plain Error.
    expect(findCauseByType(wrapper, DatabaseError)).toBeNull();
    // findCauseByName succeeds — it only checks the name string.
    expect(findCauseByName(wrapper, 'DatabaseError')).toBe(deserialised);
  });
});
