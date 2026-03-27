import { describe, expect, it } from 'vitest';

import {
  VError,
  WError,
  findCauseByName,
  findCauseByType,
  hasCauseWithName,
  hasCauseWithType
} from '../src/index.ts';

/** A plain Error subclass that does NOT extend VError. */
class MyError extends Error {
  constructor() {
    super('gna gna gna');
    this.name = 'MyError';
  }
}

// Named VError subclasses — override readonly name with as const.
class ErrorTwo extends VError {
  override readonly name = 'ErrorTwo' as const;
}

class ErrorThree extends WError {
  override readonly name = 'ErrorThree' as const;
}

describe('findCauseByName / hasCauseWithName', () => {
  const err1 = new MyError();
  const err2 = new ErrorTwo('basic verror', { cause: err1 });
  const err3 = new ErrorThree('werror', { cause: err2 });

  it('traverses the full chain from err3', () => {
    expect(findCauseByName(err3, 'ErrorFour')).toBeNull();
    expect(hasCauseWithName(err3, 'ErrorFour')).toBe(false);
    expect(findCauseByName(err3, 'ErrorThree')).toBe(err3);
    expect(hasCauseWithName(err3, 'ErrorThree')).toBe(true);
    expect(findCauseByName(err3, 'ErrorTwo')).toBe(err2);
    expect(hasCauseWithName(err3, 'ErrorTwo')).toBe(true);
    expect(findCauseByName(err3, 'MyError')).toBe(err1);
    expect(hasCauseWithName(err3, 'MyError')).toBe(true);
  });

  it('traverses from err2', () => {
    expect(findCauseByName(err2, 'ErrorThree')).toBeNull();
    expect(findCauseByName(err2, 'ErrorTwo')).toBe(err2);
    expect(findCauseByName(err2, 'MyError')).toBe(err1);
  });

  it('works on non-VError errors', () => {
    expect(findCauseByName(err1, 'MyError')).toBe(err1);
    expect(hasCauseWithName(err1, 'MyError')).toBe(true);
    expect(findCauseByName(err1, 'ErrorTwo')).toBeNull();
  });

  it('works on a plain Error', () => {
    const plain = new Error('oops');
    expect(findCauseByName(plain, 'Error')).toBe(plain);
    expect(findCauseByName(plain, 'MyError')).toBeNull();
  });

  it('throws for non-Error first argument', () => {
    expect(() => findCauseByName(null as unknown as Error, 'AnError')).toThrow();
    expect(() => hasCauseWithName(null as unknown as Error, 'AnError')).toThrow();
  });

  it('throws for non-string name', () => {
    expect(() => findCauseByName(err1, null as unknown as string)).toThrow();
    expect(() => hasCauseWithName(err1, null as unknown as string)).toThrow();
  });
});

describe('findCauseByType / hasCauseWithType', () => {
  const err1 = new MyError();
  const err2 = new ErrorTwo('basic verror', { cause: err1 });
  const err3 = new ErrorThree('werror', { cause: err2 });

  it('traverses the full chain from err3', () => {
    expect(findCauseByType(err3, MyError)).toBe(err1);
    expect(hasCauseWithType(err3, MyError)).toBe(true);
    expect(findCauseByType(err3, ErrorThree)).toBe(err3);
    expect(hasCauseWithType(err3, ErrorThree)).toBe(true);
    expect(findCauseByType(err3, VError)).toBe(err3);
  });

  it('traverses from err2', () => {
    expect(findCauseByType(err2, MyError)).toBe(err1);
    expect(findCauseByType(err2, ErrorThree)).toBeNull();
    expect(hasCauseWithType(err2, ErrorThree)).toBe(false);
  });

  it('works on a plain Error', () => {
    const plain = new Error('oops');
    expect(findCauseByType(plain, Error)).toBe(plain);
  });

  it('throws for non-Error first argument', () => {
    expect(() => findCauseByType(null as unknown as Error, MyError)).toThrow();
    expect(() => hasCauseWithType(null as unknown as Error, MyError)).toThrow();
  });

  it('throws for non-function type', () => {
    expect(() => findCauseByType(err1, null as unknown as typeof MyError)).toThrow();
    expect(() => hasCauseWithType(err1, null as unknown as typeof MyError)).toThrow();
  });
});
