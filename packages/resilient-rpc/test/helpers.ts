import type { Mock } from 'vitest';

import { vi } from 'vitest';

import type { PoolLogger, RawRequest } from '../src/types.ts';

export interface CapturedLogger {
  logger: PoolLogger;
  debug: Mock;
  info: Mock;
  warn: Mock;
  error: Mock;
}

/**
 * pino's `LogFn` is an overload set a bare `vi.fn()` cannot satisfy
 * structurally, so this helper carries the suite's one sanctioned mock cast.
 */
export const makeLogger = (): CapturedLogger => {
  const debug = vi.fn();
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const logger = { debug, info, warn, error } as unknown as PoolLogger;
  return { logger, debug, info, warn, error };
};

/** A Node-style transport error (`ECONNREFUSED`, `ENOTFOUND`, …). */
export const transportError = (code: string): Error =>
  Object.assign(new Error(`transport failure: ${code}`), { code });

export type Responder = (args: { method: string }) => Promise<unknown>;

/** A scripted wire: per-origin responders plus a call log of origins hit. */
export const scriptedWire = (
  byOrigin: Record<string, Responder>
): { wire: RawRequest; calls: string[] } => {
  const calls: string[] = [];
  const wire: RawRequest = async ({ endpoint, method }) => {
    calls.push(endpoint.origin);
    const responder = byOrigin[endpoint.origin];
    if (!responder) throw new Error(`no responder scripted for ${endpoint.origin}`);
    return responder({ method });
  };
  return { wire, calls };
};

/** Awaits a promise that MUST reject and hands back the rejection value. */
export const captureRejection = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (err: unknown) => err
  );
