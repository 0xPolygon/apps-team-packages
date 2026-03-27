import { describe, expect, it } from 'vitest';

import { VError } from '../src/index.ts';

describe('VError.info — cause chain propagation', () => {
  it('no info', () => {
    const root = new Error('bad');
    const err = new VError('worse', { cause: root });
    expect(VError.cause(err)).toBe(root);
    expect(err.message).toBe('worse: bad');
    expect(VError.info(err)).toEqual({});
  });

  it('simple info usage', () => {
    const infoObj = { errno: 'EDEADLK', anObject: { hello: 'world' } };
    const err = new VError('bad', { info: infoObj });
    expect(VError.info(err)).toEqual(infoObj);
  });

  it('info propagates from cause to wrapper', () => {
    const infoObj = { errno: 'EDEADLK', anObject: { hello: 'world' } };
    const err1 = new VError('bad', { info: infoObj });
    const err2 = new VError('worse', { cause: err1 });
    expect(VError.cause(err2)).toBe(err1);
    expect(err2.message).toBe('worse: bad');
    expect(VError.info(err2)).toEqual(infoObj);
  });

  it('closer error overrides info from deeper cause', () => {
    const err1 = new VError('bad', {
      info: { errno: 'EDEADLK', anObject: { hello: 'world' } }
    });
    const err2 = new VError('worse', { cause: err1, info: { anObject: { hello: 'moon' } } });
    expect(VError.info(err2)).toEqual({ errno: 'EDEADLK', anObject: { hello: 'moon' } });
  });

  it('three-level info chain', () => {
    const err1 = new VError('bad', {
      info: { errno: 'EDEADLK', anObject: { hello: 'world' } }
    });
    const err2 = new VError('worse', { cause: err1, info: { anObject: { hello: 'moon' } } });
    const err3 = new VError('what next', {
      cause: err2,
      info: { remoteIp: '127.0.0.1' }
    });
    expect(VError.cause(err3)).toBe(err2);
    expect(err3.message).toBe('what next: worse: bad');
    expect(VError.info(err3)).toEqual({
      remoteIp: '127.0.0.1',
      errno: 'EDEADLK',
      anObject: { hello: 'moon' }
    });
  });

  it('throws for non-Error', () => {
    expect(() => VError.info(null as unknown as Error)).toThrow();
  });
});
