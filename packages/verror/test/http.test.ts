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
  VError
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

describe('HTTP error with cause', () => {
  it('BadRequest can have a cause', () => {
    const root = new Error('validation failed');
    const err = new BadRequest('bad input', { cause: root });
    expect(VError.cause(err)).toBe(root);
    expect(err.message).toBe('bad input: validation failed');
    expect(err.statusCode).toBe(400);
  });

  it('BadRequest with info', () => {
    const err = new BadRequest('invalid field', { info: { field: 'email' } });
    expect(err.statusCode).toBe(400);
    expect(VError.info(err)['field']).toBe('email');
  });
});
