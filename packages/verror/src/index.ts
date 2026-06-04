export {
  serializeError,
  VError,
  WError,
  MultiError,
  WERROR_SYMBOL,
  MULTIERROR_SYMBOL
} from './verror.ts';
export { sanitiseRpcFetchError } from './sanitise.ts';
export type { VErrorOptions } from './types.ts';
export {
  HTTPError,
  BadRequest,
  NotAuthenticated,
  PaymentError,
  Forbidden,
  NotFound,
  MethodNotAllowed,
  NotAcceptable,
  Timeout,
  Conflict,
  Gone,
  LengthRequired,
  Unprocessable,
  TooManyRequests,
  GeneralError,
  NotImplemented,
  BadGateway,
  Unavailable
} from './http.ts';

// Standalone named exports for the VError static helpers so consumers can
// import them without going through the class:
//   import { findCauseByName, cause } from '@polygonlabs/verror'
import { VError } from './verror.ts';

export const cause = (err: Error): Error | null => VError.cause(err);
export const info = (err: Error): Record<string, unknown> => VError.info(err);
export const fullStack = (err: Error): string => VError.fullStack(err);
export const errorFromList = (errors: Error[]): Error | null => VError.errorFromList(errors);
export const errorForEach = (err: Error, func: (e: Error) => void): void =>
  VError.errorForEach(err, func);
export const findCauseByName = (err: Error, name: string): Error | null =>
  VError.findCauseByName(err, name);
export const findCauseByType = <T extends Error>(err: Error, type: { prototype: T }): T | null =>
  VError.findCauseByType(err, type);
export const hasCauseWithName = (err: Error, name: string): boolean =>
  VError.hasCauseWithName(err, name);
export const hasCauseWithType = <T extends Error>(err: Error, type: { prototype: T }): boolean =>
  VError.hasCauseWithType(err, type);
