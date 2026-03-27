import type { Bindings, ChildLoggerOptions, DestinationStream, Logger, LoggerOptions } from 'pino';

import { pino, stdSerializers } from 'pino';

import { VError, WError } from '@polygonlabs/verror';

/**
 * Duck-typed interface for Sentry error capturing. Matches the surface of
 * @sentry/node used by logError. Pass an initialised Sentry client to
 * createLogger to activate automatic error capture alongside pino logging.
 */
export interface SentryAdapter {
  captureException(err: unknown): void;
  captureMessage(msg: string, level: string): void;
}

/**
 * pino Logger extended with logError and a narrowed child() return type.
 *
 * logError is a VError/WError-aware error logging helper: use it in preference
 * to logger.error() for caught exceptions so that VError info fields are emitted
 * as discrete structured fields and WError cause chains are fully unwound into
 * separate log entries.
 *
 * child() is overridden to return AppLogger so child loggers inherit logError
 * and the override is preserved at any depth.
 *
 * Inject this type throughout your service rather than importing a module-level
 * singleton. Construct once at the entry point and pass down via constructor
 * arguments or function parameters.
 */
export type AppLogger = Omit<Logger, 'child'> & {
  /**
   * Log an error at `error` level. Mirrors pino's merge-object signature with
   * `err` as a required key:
   *
   *   logger.logError({ err })
   *   logger.logError({ err, requestId, userId }, 'optional message override')
   *
   * VError `info` fields from the full cause chain are spread into the log entry
   * alongside any call-site context. Call-site context wins on key collision.
   * WError wrappers are skipped — only the cause is logged.
   */
  /**
   * Log an error at `error` level. Mirrors pino's merge-object signature with
   * `err` as a required key:
   *
   *   logger.logError({ err })
   *   logger.logError({ err, requestId, userId }, 'optional message override')
   *
   * VError `info` from the full cause chain is always emitted under the `error_info`
   * key — never spread at the top level. This means `error_info` is a reserved key:
   * passing it in the context object is a TypeScript error.
   *
   * `err` must be an `Error` instance. For non-Error caught values, narrow first or
   * use `logger.error()` directly.
   */
  logError(
    obj: { err: Error; error_info?: never } & Record<string, unknown>,
    message?: string
  ): void;
  child(bindings: Bindings, options?: ChildLoggerOptions): AppLogger;
};

export interface CreateLoggerOptions {
  /** Enable pino-pretty output for development. Requires pino-pretty to be installed. */
  pretty?: boolean;
  /**
   * Custom pino destination stream. When provided, takes precedence over `pretty`.
   * Intended for use in tests to capture log output.
   */
  destination?: DestinationStream;
  /**
   * Optional Sentry adapter for automatic error capturing in logError.
   * Pass your initialised @sentry/node instance (or any object satisfying
   * SentryAdapter). Propagated automatically to all child loggers.
   */
  sentry?: SentryAdapter;
}

function logError(
  logger: Logger,
  obj: { err: Error } & Record<string, unknown>,
  message: string | undefined,
  sentry: SentryAdapter | undefined
): void {
  const { err, ...context } = obj;

  // WError is a wrapper whose own message is intentionally not the useful signal —
  // the cause is. Skip the WError itself and recurse directly into its cause.
  // Carry call-site context through; discard the developer's message override since
  // it described the wrapper, not the cause.
  if (err instanceof WError) {
    const cause = VError.cause(err);
    // The spread of context (Record<string, unknown>) widens err back to unknown;
    // cast is safe because cause is narrowed to Error by the if-guard above.
    if (cause)
      logError(
        logger,
        { err: cause, ...context } as { err: Error } & Record<string, unknown>,
        undefined,
        sentry
      );
    return;
  }

  // info from the full cause chain is spread first so call-site context wins on collision.
  const info = err instanceof VError ? VError.info(err) : {};
  const infoEntry = Object.keys(info).length > 0 ? { error_info: info } : {};
  logger.error({ err, ...context, ...infoEntry }, message ?? err.message);
  sentry?.captureException(err);
}

export async function createLogger(options?: CreateLoggerOptions): Promise<AppLogger> {
  // ref.self is assigned immediately after pino() returns. The formatters.log
  // closure only fires when a log method is called — never during construction —
  // so ref.self is always defined by the time the closure executes.
  const ref: { self: AppLogger | undefined } = { self: undefined };

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
      // Detect a caller-supplied "timestamp" key and rename it so it cannot
      // shadow the authoritative timestamp written by the timestamp function.
      log(object: Record<string, unknown>) {
        if ('timestamp' in object) {
          const { timestamp, ...rest } = object;
          ref.self?.warn(
            { callerTimestamp: timestamp },
            'Log call included "timestamp" in merge object — reserved key renamed to callerTimestamp. Fix the call site.'
          );
          return { callerTimestamp: timestamp, ...rest };
        }
        return object;
      }
    },
    serializers: {
      err: stdSerializers.err
    }
  };

  let destination: DestinationStream | undefined = options?.destination;
  if (!destination && options?.pretty) {
    destination = (await import('pino-pretty')).default({
      colorize: true,
      timestampKey: 'timestamp',
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
      sync: true
    });
  }

  const base = destination ? pino(pinoOptions, destination) : pino(pinoOptions);

  // Capture child from Logger.prototype directly rather than from the instance, so we
  // hold a reference to the prototype method that cannot be shadowed by an own property.
  // We call it with .call(target) where target is the raw pino instance (never the Proxy),
  // so pino's child creation runs with a clean `this` and produces a raw child whose
  // prototype chain is pure pino. We then wrap that child in a new Proxy via enrichLogger.
  const pinoProtoChild = (Object.getPrototypeOf(base) as Logger).child as unknown as (
    this: Logger,
    bindings: Bindings,
    options?: ChildLoggerOptions
  ) => Logger;

  function enrichLogger(instance: Logger): AppLogger {
    // Wrap in a Proxy rather than mutating the pino logger instance. Mutation would
    // make logError and child OWN properties on the pino object, which become visible
    // in descendant loggers via their prototype chain (pino creates children with
    // Object.create(parent)). A Proxy intercepts only the two properties we care about
    // and passes everything else through to the original logger untouched.
    return new Proxy(instance, {
      get(target, prop, receiver) {
        if (prop === 'logError') {
          return (
            obj: { err: Error; error_info?: never } & Record<string, unknown>,
            message?: string
          ) => logError(target, obj, message, options?.sentry);
        }
        if (prop === 'child') {
          return (bindings: Bindings, childOptions?: ChildLoggerOptions): AppLogger =>
            enrichLogger(pinoProtoChild.call(target, bindings, childOptions) as unknown as Logger);
        }
        return Reflect.get(target, prop, receiver);
      }
    }) as unknown as AppLogger;
  }

  const logger = enrichLogger(base);
  ref.self = logger;
  return logger;
}
