import { VError } from './verror.ts';

/**
 * Base class for all HTTP-specific errors.  Provides `statusCode` with `toJSON()`
 *
 * Extend this class (or any concrete subclass) to create domain-specific HTTP
 * error types:
 *
 *   class ResourceNotFound extends NotFound {
 *     override readonly name = 'ResourceNotFound' as const;
 *   }
 */
export class HTTPError extends VError {
  override readonly name: string = 'HTTPError';
  declare readonly statusCode: number;

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      statusCode: this.statusCode
    };
  }
}

export class BadRequest extends HTTPError {
  override readonly name = 'BadRequest' as const;
  override readonly statusCode = 400 as const;
}

export class NotAuthenticated extends HTTPError {
  override readonly name = 'NotAuthenticated' as const;
  override readonly statusCode = 401 as const;
}

export class PaymentError extends HTTPError {
  override readonly name = 'PaymentError' as const;
  override readonly statusCode = 402 as const;
}

export class Forbidden extends HTTPError {
  override readonly name = 'Forbidden' as const;
  override readonly statusCode = 403 as const;
}

export class NotFound extends HTTPError {
  override readonly name = 'NotFound' as const;
  override readonly statusCode = 404 as const;
}

export class MethodNotAllowed extends HTTPError {
  override readonly name = 'MethodNotAllowed' as const;
  override readonly statusCode = 405 as const;
}

export class NotAcceptable extends HTTPError {
  override readonly name = 'NotAcceptable' as const;
  override readonly statusCode = 406 as const;
}

export class Timeout extends HTTPError {
  override readonly name = 'Timeout' as const;
  override readonly statusCode = 408 as const;
}

export class Conflict extends HTTPError {
  override readonly name = 'Conflict' as const;
  override readonly statusCode = 409 as const;
}

export class Gone extends HTTPError {
  override readonly name = 'Gone' as const;
  override readonly statusCode = 410 as const;
}

export class LengthRequired extends HTTPError {
  override readonly name = 'LengthRequired' as const;
  override readonly statusCode = 411 as const;
}

export class Unprocessable extends HTTPError {
  override readonly name = 'Unprocessable' as const;
  override readonly statusCode = 422 as const;
}

export class TooManyRequests extends HTTPError {
  override readonly name = 'TooManyRequests' as const;
  override readonly statusCode = 429 as const;
}

export class GeneralError extends HTTPError {
  override readonly name = 'GeneralError' as const;
  override readonly statusCode = 500 as const;
}

export class NotImplemented extends HTTPError {
  override readonly name = 'NotImplemented' as const;
  override readonly statusCode = 501 as const;
}

export class BadGateway extends HTTPError {
  override readonly name = 'BadGateway' as const;
  override readonly statusCode = 502 as const;
}

export class Unavailable extends HTTPError {
  override readonly name = 'Unavailable' as const;
  override readonly statusCode = 503 as const;
}
