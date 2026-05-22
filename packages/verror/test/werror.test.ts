import { describe, expect, it } from 'vitest';

import { VError, WError, WERROR_SYMBOL } from '../src/index.ts';

describe('WERROR_SYMBOL', () => {
  it('is present on WError instances', () => {
    const err = new WError('msg', { cause: new Error('root') });
    expect((err as unknown as Record<symbol, unknown>)[WERROR_SYMBOL]).toBe(true);
  });

  it('is present on WError subclass instances', () => {
    class SpecificError extends WError {
      override readonly name = 'SpecificError' as const;
    }
    const err = new SpecificError('msg', { cause: new Error('root') });
    expect((err as unknown as Record<symbol, unknown>)[WERROR_SYMBOL]).toBe(true);
  });

  it('is absent on plain VError instances', () => {
    const err = new VError('msg');
    expect((err as unknown as Record<symbol, unknown>)[WERROR_SYMBOL]).toBeUndefined();
  });

  it('is absent on plain Error instances', () => {
    const err = new Error('msg');
    expect((err as unknown as Record<symbol, unknown>)[WERROR_SYMBOL]).toBeUndefined();
  });

  it('equals Symbol.for with the canonical key', () => {
    expect(WERROR_SYMBOL).toBe(Symbol.for('@polygonlabs/verror/is-werror'));
  });
});

describe('WError — construction', () => {
  it('message with cause', () => {
    const root = new Error('root cause');
    const err = new WError('my error', { cause: root });
    expect(err.name).toBe('WError');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(VError);
    expect(err).toBeInstanceOf(WError);
    expect(err.message).toBe('my error');
    expect(VError.cause(err)).toBe(root);
  });

  it('subclass name via override readonly name as const', () => {
    class SomeOtherError extends WError {
      override readonly name = 'SomeOtherError' as const;
    }
    const root = new Error('root');
    const err = new SomeOtherError('another kind of error', { cause: root });
    expect(err.name).toBe('SomeOtherError');
    expect(err).toBeInstanceOf(WError);
    expect(err.message).toBe('another kind of error');
  });

  it('message with cause and info', () => {
    const root = new Error('root');
    const err = new WError('context', { cause: root, info: { requestId: 'abc' } });
    expect(VError.info(err)['requestId']).toBe('abc');
  });

  it('message containing percent signs is preserved literally', () => {
    const root = new Error('root');
    expect(new WError('100% complete', { cause: root }).message).toBe('100% complete');
  });
});

describe('WError — cause message is NOT appended', () => {
  it('own message is kept separate from cause message', () => {
    const root = new Error('root cause');
    const err = new WError('proximate cause: 3 issues', { cause: root });
    expect(err.message).toBe('proximate cause: 3 issues');
    expect(VError.cause(err)).toBe(root);
  });

  it('chained WErrors — messages stay separate', () => {
    const root = new Error('root cause');
    const mid = new WError('proximate cause: 3 issues', { cause: root });
    const top = new WError('top', { cause: mid });
    expect(top.message).toBe('top');
    expect(VError.cause(top)).toBe(mid);
  });

  it('caused by a VError', () => {
    const root = new Error('root cause');
    const vErr = new VError('mid', { cause: root });
    const wErr = new WError('top', { cause: vErr });
    expect(wErr.message).toBe('top');
    expect(VError.cause(wErr)).toBe(vErr);
  });
});

describe('WError — toString', () => {
  // WError.toString returns ONLY the wrapper's own `name: message`. The
  // cause is reachable via `err.cause` / `VError.cause(err)` and walked
  // by the serialiser for logs, but never re-appended to a stringified
  // form. This is the boundary contract: anywhere a WError is coerced
  // to string (template literals, accidental `${err}` in a hand-rolled
  // response message, console formatters), only the boundary-author's
  // message surfaces — never the underlying cause.

  it('message — cause text does NOT leak into toString', () => {
    const root = new Error('root cause');
    expect(new WError('proximate cause: 3 issues', { cause: root }).toString()).toBe(
      'WError: proximate cause: 3 issues'
    );
  });

  it('chained WErrors — each layer toStrings to its own', () => {
    const root = new Error('root cause');
    const mid = new WError('proximate cause: 3 issues', { cause: root });
    const top = new WError('top', { cause: mid });
    expect(top.toString()).toBe('WError: top');
    expect(mid.toString()).toBe('WError: proximate cause: 3 issues');
  });

  it('caused by VError — VError cause text does NOT leak through W boundary', () => {
    const root = new Error('root cause');
    const vErr = new VError('mid', { cause: root });
    expect(new WError('top', { cause: vErr }).toString()).toBe('WError: top');
  });
});
