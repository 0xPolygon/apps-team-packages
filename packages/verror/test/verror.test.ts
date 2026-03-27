import { describe, expect, it } from 'vitest';

import { VError, WError, serializeError } from '../src/index.ts';

describe('VError — basic construction', () => {
  it('simple message', () => {
    const err = new VError('my error');
    expect(err.name).toBe('VError');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(VError);
    expect(err.message).toBe('my error');
    expect(VError.cause(err)).toBeNull();
  });

  it('message with options', () => {
    const err = new VError('my error', {});
    expect(err.message).toBe('my error');
    expect(VError.cause(err)).toBeNull();
  });

  it('name comes from the prototype, not options', () => {
    expect(new VError('test').name).toBe('VError');
  });

  it('instanceof checks', () => {
    const err = new VError('test');
    expect(err).toBeInstanceOf(VError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('VError — cause chain', () => {
  it('caused by a plain Error', () => {
    const root = new Error('root cause');
    const err = new VError('wrapper', { cause: root });
    expect(err.message).toBe('wrapper: root cause');
    expect(VError.cause(err)).toBe(root);
  });

  it('empty message with cause — message becomes cause.message', () => {
    const root = new Error('root cause');
    const err = new VError('', { cause: root });
    expect(err.message).toBe('root cause');
    expect(err.shortMessage).toBe('');
    expect(VError.cause(err)).toBe(root);
  });

  it('three-level cause chain', () => {
    const err1 = new VError('root');
    const err2 = new VError('mid', { cause: err1 });
    const err3 = new VError('top', { cause: err2 });
    expect(err3.message).toBe('top: mid: root');
    expect(VError.cause(err3)).toBe(err2);
    expect(VError.cause(err2)).toBe(err1);
  });

  it('caused by a WError — only WError own message is appended', () => {
    const root = new Error('root cause');
    const mid = new WError('mid', { cause: root });
    const top = new VError('top', { cause: mid });
    expect(top.message).toBe('top: mid');
    expect(VError.cause(top)).toBe(mid);
  });

  it('shortMessage is the literal message argument', () => {
    const root = new Error('root');
    const err = new VError('wrapper', { cause: root });
    expect(err.shortMessage).toBe('wrapper');
    expect(err.message).toBe('wrapper: root');
  });
});

describe('VError — fullStack', () => {
  it('single error', () => {
    const err = new VError('oops');
    expect(VError.fullStack(err)).toContain('VError: oops');
    expect(VError.fullStack(err)).not.toContain('caused by');
  });

  it('two-level cause chain', () => {
    const root = new Error('root cause');
    const err = new VError('top', { cause: root });
    const stack = VError.fullStack(err);
    expect(stack).toContain('VError: top: root cause');
    expect(stack).toContain('caused by: Error: root cause');
  });

  it('throws for non-Error', () => {
    expect(() => VError.fullStack(null as unknown as Error)).toThrow();
  });
});

describe('VError — toString', () => {
  it('with message', () => {
    expect(new VError('something').toString()).toBe('VError: something');
  });

  it('subclass with override readonly name appears in toString', () => {
    class MyError extends VError {
      override readonly name = 'MyError' as const;
    }
    expect(new MyError('boom').toString()).toBe('MyError: boom');
  });
});

describe('VError — toJSON', () => {
  it('basic fields', () => {
    const err = new VError('test error');
    expect(err.toJSON()).toMatchObject({
      name: 'VError',
      message: 'test error',
      shortMessage: 'test error',
      cause: undefined,
      info: {}
    });
  });

  it('serializes the cause chain rather than including a raw reference', () => {
    const root = new Error('root');
    const err = new VError('wrapper', { cause: root });
    expect(err.toJSON()['cause']).toEqual({
      name: 'Error',
      message: 'root',
      shortMessage: 'root',
      info: {}
    });
  });
});

describe('serializeError', () => {
  it('serializes a plain Error to the VError shape', () => {
    expect(serializeError(new Error('oops'))).toEqual({
      name: 'Error',
      message: 'oops',
      shortMessage: 'oops',
      info: {}
    });
  });

  it('recursively serializes native Error.cause chains', () => {
    const root = new Error('ECONNREFUSED');
    const native = new Error('upstream timed out', { cause: root });
    expect(serializeError(native)).toEqual({
      name: 'Error',
      message: 'upstream timed out',
      shortMessage: 'upstream timed out',
      cause: { name: 'Error', message: 'ECONNREFUSED', shortMessage: 'ECONNREFUSED', info: {} },
      info: {}
    });
  });

  it('delegates to toJSON() for VError instances', () => {
    const err = new VError('query failed', { info: { requestId: 'abc' } });
    expect(serializeError(err)).toEqual(err.toJSON());
  });

  it('returns undefined for non-Error values', () => {
    expect(serializeError(undefined)).toBeUndefined();
    expect(serializeError('a string')).toBeUndefined();
    expect(serializeError(42)).toBeUndefined();
  });
});

describe('VError — static cause()', () => {
  it('returns cause', () => {
    const root = new Error('root');
    expect(VError.cause(new VError('wrapper', { cause: root }))).toBe(root);
  });

  it('returns null when no cause', () => {
    expect(VError.cause(new VError('no cause'))).toBeNull();
  });

  it('throws for non-Error', () => {
    expect(() => VError.cause(null as unknown as Error)).toThrow();
  });
});
