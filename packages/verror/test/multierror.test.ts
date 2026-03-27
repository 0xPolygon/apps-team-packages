import { describe, expect, it } from 'vitest';

import { MultiError, VError, errorForEach, errorFromList } from '../src/index.ts';

describe('MultiError', () => {
  const err1 = new Error('error one');
  const err2 = new Error('error two');
  const err3 = new Error('error three');

  it('throws with no arguments', () => {
    expect(() => new MultiError(undefined as unknown as Error[])).toThrow();
  });

  it('throws with an empty array', () => {
    expect(() => new MultiError([])).toThrow();
  });

  it('three errors', () => {
    const merr = new MultiError([err1, err2, err3]);
    expect(VError.cause(merr)).toBe(err1);
    expect(merr.message).toBe('first of 3 errors: error one');
    expect(merr.name).toBe('MultiError');
    expect(merr).toBeInstanceOf(MultiError);
    expect(merr).toBeInstanceOf(VError);
  });

  it('one error', () => {
    const merr = new MultiError([err1]);
    expect(merr.message).toBe('first of 1 error: error one');
    expect(merr.name).toBe('MultiError');
  });

  it('errors property contains all errors', () => {
    const merr = new MultiError([err1, err2, err3]);
    expect(merr.errors).toEqual([err1, err2, err3]);
  });
});

describe('errorFromList', () => {
  const err1 = new Error('error one');
  const err2 = new Error('error two');
  const err3 = new Error('error three');

  it('throws for non-array', () => {
    expect(() => errorFromList(null as unknown as Error[])).toThrow();
    expect(() => errorFromList('asdf' as unknown as Error[])).toThrow();
  });

  it('throws for array containing non-Errors', () => {
    expect(() => errorFromList([new Error(), 17 as unknown as Error])).toThrow();
  });

  it('returns null for empty array', () => {
    expect(errorFromList([])).toBeNull();
  });

  it('returns the single error for a one-element array', () => {
    expect(errorFromList([err1])).toBe(err1);
  });

  it('returns a MultiError for multiple errors', () => {
    const merr = errorFromList([err1, err2, err3]);
    expect(merr).toBeInstanceOf(MultiError);
    expect((merr as MultiError).errors).toEqual([err1, err2, err3]);
  });
});

describe('errorForEach', () => {
  const err1 = new Error('error one');
  const err2 = new Error('error two');
  const err3 = new Error('error three');

  it('throws for non-Error', () => {
    expect(() => errorForEach(null as unknown as Error, () => {})).toThrow();
    expect(() => errorForEach({} as unknown as Error, () => {})).toThrow();
  });

  it('throws for non-function callback', () => {
    expect(() => errorForEach(err1, null as unknown as (e: Error) => void)).toThrow();
  });

  it('calls func once for a plain Error', () => {
    const seen: Error[] = [];
    errorForEach(err1, (e) => seen.push(e));
    expect(seen).toEqual([err1]);
  });

  it('calls func for each error in a MultiError', () => {
    const merr = errorFromList([err1, err2, err3]) as MultiError;
    const seen: Error[] = [];
    errorForEach(merr, (e) => seen.push(e));
    expect(seen).toEqual([err1, err2, err3]);
  });

  it('toJSON includes errors array', () => {
    const merr = errorFromList([err1, err2, err3]) as MultiError;
    expect(merr.toJSON()).toEqual({
      name: 'MultiError',
      message: 'first of 3 errors: error one',
      shortMessage: 'first of 3 errors',
      cause: { name: 'Error', message: 'error one', shortMessage: 'error one', info: {} },
      info: {},
      errors: [
        {
          name: 'Error',
          message: 'error one',
          shortMessage: 'error one',
          cause: undefined,
          info: {}
        },
        {
          name: 'Error',
          message: 'error two',
          shortMessage: 'error two',
          cause: undefined,
          info: {}
        },
        {
          name: 'Error',
          message: 'error three',
          shortMessage: 'error three',
          cause: undefined,
          info: {}
        }
      ]
    });
  });
});
