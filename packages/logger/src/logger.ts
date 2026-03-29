import type { DestinationStream, Logger, LoggerOptions } from 'pino';

import { pino, stdSerializers } from 'pino';

import { VError, WError } from '@polygonlabs/verror';

/**
 * Duck-typed interface for Sentry error capturing. Matches the surface of
 * @sentry/node used by automatic error capture on logger.error() calls. Pass
 * an initialised Sentry client to createLogger to activate it.
 */
export interface SentryAdapter {
  captureException(err: unknown): void;
  captureMessage(msg: string, level: string): void;
}

export interface CreateLoggerOptions {
  /** Enable pino-pretty output for development. Requires pino-pretty to be installed. */
  pretty?: boolean;
  /**
   * Custom pino destination stream. When provided, takes precedence over `pretty`.
   * Intended for use in tests to capture log output.
   */
  destination?: DestinationStream;
  /**
   * Optional Sentry adapter for automatic error capturing on logger.error() and
   * logger.fatal() calls. Pass your initialised @sentry/node instance (or any
   * object satisfying SentryAdapter). Inherited by all child loggers.
   */
  sentry?: SentryAdapter;
}

// Pino's numeric level for "error". Levels at or above this (error=50, fatal=60)
// are captured in Sentry.
const PINO_ERROR_LEVEL = 50;

export async function createLogger(options?: CreateLoggerOptions): Promise<Logger> {
  // ref.self is assigned immediately after pino() returns. The formatters.log
  // closure only fires when a log method is called — never during construction —
  // so ref.self is always defined by the time the closure executes.
  const ref: { self: Logger | undefined } = { self: undefined };

  const pinoOptions: LoggerOptions = {
    level: 'debug',
    // Rename pino's default "msg" key to "message" for Datadog ingestion.
    messageKey: 'message',
    // Suppress pino's default pid and hostname fields.
    base: undefined,
    // Write ISO 8601 as "timestamp" — Datadog's expected field name.
    // pino's default is Unix epoch under "time". The leading comma is required
    // because pino appends this fragment directly onto the partially-constructed
    // JSON string.
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: {
      // Emit string level labels ("info") instead of numeric values (30).
      level(label: string) {
        return { level: label };
      },
      log(object: Record<string, unknown>) {
        let out = object;

        // Detect a caller-supplied "timestamp" key and rename it so it cannot
        // shadow the authoritative timestamp written by the timestamp function.
        if ('timestamp' in out) {
          const { timestamp, ...rest } = out;
          ref.self?.warn(
            { callerTimestamp: timestamp },
            'Log call included "timestamp" in merge object — reserved key renamed to callerTimestamp. Fix the call site.'
          );
          out = { callerTimestamp: timestamp, ...rest };
        }

        // Detect a caller-supplied "error_info" key and strip it — the correct
        // value is derived from the err below. Preserve the caller's value in a
        // warning so it is not silently lost.
        if ('error_info' in out) {
          const { error_info, ...rest } = out;
          ref.self?.warn(
            { callerErrorInfo: error_info },
            'Log call included "error_info" in merge object — reserved key ignored. Fix the call site.'
          );
          out = rest;
        }

        // Emit merged VError info chain under error_info for structured querying.
        // By this point hooks.logMethod has already unwrapped any WError, so err
        // is always the meaningful cause when it arrives here.
        if (out['err'] instanceof VError) {
          const info = VError.info(out['err']);
          if (Object.keys(info).length > 0) out = { ...out, error_info: info };
        }

        return out;
      }
    },
    serializers: {
      err: stdSerializers.err
    },
    hooks: {
      logMethod(args, method, level) {
        const first = args[0];
        if (first !== null && typeof first === 'object' && 'err' in (first as object)) {
          const obj = first as Record<string, unknown>;
          if (obj['err'] instanceof Error) {
            // Unwrap WError chain — WError's own message is never the useful signal.
            let err: Error = obj['err'];
            while (err instanceof WError) {
              const cause = VError.cause(err);
              if (cause === null) break;
              err = cause;
            }
            if (err !== obj['err']) (args as unknown[])[0] = { ...obj, err };

            // Capture in Sentry for error and fatal.
            if (level >= PINO_ERROR_LEVEL) options?.sentry?.captureException(err);
          }
        }
        method.apply(this, args);
      }
    }
  };

  let destination: DestinationStream | undefined = options?.destination;
  if (!destination && options?.pretty) {
    try {
      destination = (await import('pino-pretty')).default({
        colorize: true,
        timestampKey: 'timestamp',
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        sync: true
      });
    } catch {
      console.warn(
        'pino-pretty is not installed — falling back to JSON output. Install it as a dev dependency to enable pretty logging.'
      );
    }
  }

  const base = destination ? pino(pinoOptions, destination) : pino(pinoOptions);

  ref.self = base;
  return base;
}
