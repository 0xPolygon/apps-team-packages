import { describe, expect, it } from 'vitest';

import {
  BadGateway,
  BadRequest,
  Conflict,
  Forbidden,
  GeneralError,
  Gone,
  HTTPError,
  LengthRequired,
  MethodNotAllowed,
  NotAcceptable,
  NotAuthenticated,
  NotFound,
  NotImplemented,
  PaymentError,
  Timeout,
  TooManyRequests,
  Unavailable,
  Unprocessable,
  VError,
  WERROR_SYMBOL
} from '../src/index.ts';

describe('HTTP error classes exist', () => {
  it('all error constructors are exported', () => {
    expect(typeof BadRequest).toBe('function');
    expect(typeof NotAuthenticated).toBe('function');
    expect(typeof PaymentError).toBe('function');
    expect(typeof Forbidden).toBe('function');
    expect(typeof NotFound).toBe('function');
    expect(typeof MethodNotAllowed).toBe('function');
    expect(typeof NotAcceptable).toBe('function');
    expect(typeof Timeout).toBe('function');
    expect(typeof Conflict).toBe('function');
    expect(typeof Gone).toBe('function');
    expect(typeof LengthRequired).toBe('function');
    expect(typeof Unprocessable).toBe('function');
    expect(typeof TooManyRequests).toBe('function');
    expect(typeof GeneralError).toBe('function');
    expect(typeof NotImplemented).toBe('function');
    expect(typeof BadGateway).toBe('function');
    expect(typeof Unavailable).toBe('function');
  });
});

describe('HTTPError inheritance', () => {
  it('HTTPError extends VError', () => {
    const err = new HTTPError('generic');
    expect(err).toBeInstanceOf(HTTPError);
    expect(err).toBeInstanceOf(VError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('HTTPError');
  });

  it('BadRequest extends HTTPError', () => {
    const err = new BadRequest('bad input');
    expect(err).toBeInstanceOf(BadRequest);
    expect(err).toBeInstanceOf(HTTPError);
    expect(err).toBeInstanceOf(VError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BadRequest');
  });

  it('NotFound extends HTTPError', () => {
    const err = new NotFound('resource missing');
    expect(err).toBeInstanceOf(NotFound);
    expect(err).toBeInstanceOf(HTTPError);
    expect(err).toBeInstanceOf(VError);
  });
});

describe('HTTP error properties', () => {
  it('BadRequest has correct statusCode', () => {
    const err = new BadRequest('something went wrong');
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('something went wrong');
  });

  it('NotFound has correct statusCode', () => {
    const err = new NotFound('resource not found');
    expect(err.statusCode).toBe(404);
  });

  it('GeneralError has correct statusCode', () => {
    const err = new GeneralError('server error');
    expect(err.statusCode).toBe(500);
  });

  it('toJSON includes statusCode', () => {
    const err = new BadRequest('something went wrong');
    expect(err.toJSON()).toStrictEqual({
      name: 'BadRequest',
      message: 'something went wrong',
      shortMessage: 'something went wrong',
      cause: undefined,
      info: {},
      statusCode: 400
    });
  });
});

describe('HTTPError is W-by-default — cause message does NOT leak into .message', () => {
  // The W-by-default behaviour is the boundary contract: HTTP errors are
  // API-emitted (client-facing), so a downstream cause's message must not
  // be appended to `.message`. The cause stays attached for log walkers
  // and `VError.cause(err)`; `.message` is the throw site's own only.

  it('BadRequest with a cause keeps its own message — cause not appended', () => {
    const root = new Error('validation failed');
    const err = new BadRequest('bad input', { cause: root });
    expect(err.message).toBe('bad input');
    expect(err.message).not.contain('validation failed');
    expect(VError.cause(err)).toBe(root);
    expect(err.statusCode).toBe(400);
  });

  it('GeneralError with a cause keeps its own message', () => {
    const inner = new Error('ZodError: [{ code: "invalid_type", ... }]');
    const err = new GeneralError('Response failed schema validation', { cause: inner });
    expect(err.message).toBe('Response failed schema validation');
    expect(err.message).not.contain('invalid_type');
    expect(VError.cause(err)).toBe(inner);
  });

  it('BadRequest with info exposes that info via VError.info', () => {
    const err = new BadRequest('invalid field', { info: { field: 'email' } });
    expect(err.statusCode).toBe(400);
    expect(VError.info(err)['field']).toBe('email');
  });

  it('every HTTPError subclass carries WERROR_SYMBOL via prototype', () => {
    // The marker lives on HTTPError.prototype (set in a static block), so
    // every subclass instance inherits it without per-class wiring.
    for (const Klass of [BadRequest, NotAuthenticated, NotFound, GeneralError, Unavailable]) {
      const err = new Klass('test');
      expect((err as unknown as Record<symbol, unknown>)[WERROR_SYMBOL]).toBe(true);
    }
  });

  it('user-defined HTTPError subclass inherits W-by-default semantics', () => {
    class ResourceLocked extends HTTPError {
      override readonly name = 'ResourceLocked' as const;
      override readonly statusCode = 423 as const;
    }
    const err = new ResourceLocked('locked', { cause: new Error('held by tx 0xabc') });
    expect(err.message).toBe('locked');
    expect(err.message).not.contain('0xabc');
    expect((err as unknown as Record<symbol, unknown>)[WERROR_SYMBOL]).toBe(true);
  });
});
