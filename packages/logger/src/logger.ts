import type { DestinationStream, Logger, LoggerOptions } from 'pino';

import { pino, stdSerializers } from 'pino';

import { sanitiseEthersFetchError, VError, WERROR_SYMBOL } from '@polygonlabs/verror';

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

        // Reserved keys — values that the logger or Datadog agent writes
        // authoritatively. If a caller includes one of these in a merge object it
        // either silently overrides the authoritative value or is silently dropped.
        //
        // Strategy: collect all caller-supplied reserved values into a single
        // nested `_logger` object. Using a namespace rather than flat renamed keys
        // (e.g. `callerTimestamp`) avoids a second collision surface — `_logger`
        // is far less likely to be used by application code than `callerFoo`.
        //
        // If `_logger` itself is in the merge object we merge into it (preserving
        // whatever the caller put there) and emit a warn, rather than clobbering.
        //
        // Reserved keys and why:
        //   timestamp  — written by the pino timestamp function; caller value
        //                would shadow the authoritative ISO 8601 string
        //   message    — written by pino as messageKey; caller value in the merge
        //                object races with the string argument
        //   service    — set by the Datadog agent from the container name; a
        //                caller value silently breaks log attribution
        //   host       — set by the Datadog agent from the container hostname; a
        //                caller value silently overrides infrastructure routing

        const RESERVED = ['timestamp', 'message', 'service', 'host'] as const;
        const shadowed: Record<string, unknown> = {};

        for (const key of RESERVED) {
          if (key in out) {
            shadowed[key] = out[key];
            const { [key]: _dropped, ...rest } = out;
            out = rest;
          }
        }

        if (Object.keys(shadowed).length > 0) {
          // Merge into any existing _logger value rather than clobber it.
          const existing =
            typeof out['_logger'] === 'object' && out['_logger'] !== null
              ? (out['_logger'] as Record<string, unknown>)
              : {};
          if ('_logger' in out && (typeof out['_logger'] !== 'object' || out['_logger'] === null)) {
            // _logger exists but is a primitive — warn separately so it isn't lost.
            ref.self?.warn(
              { _logger: out['_logger'] },
              'Log call included "_logger" as a non-object — overwritten by logger internals. Fix the call site.'
            );
          }
          out = { ...out, _logger: { ...existing, ...shadowed } };
          const keys = Object.keys(shadowed).join(', ');
          ref.self?.warn(
            { _logger: shadowed },
            `Log call included reserved key(s) [${keys}] in merge object — moved to _logger. Fix the call site.`
          );
        }

        return out;
      }
    },
    serializers: {
      // Extend pino's standard err serializer with two transforms:
      //
      // 1. RPC fetch-error sanitisation. If `err` (or anything in its
      //    `.cause` chain) matches the ethers v5/v6 or viem fetch-error
      //    fingerprint, replace it with a sanitised clone whose messages
      //    and stacks are URL-stripped and whose detected node's
      //    `info.requestUrl` is reduced to origin (ethers) or emptied
      //    (viem, which carries the URL only in message text). The
      //    wrapping cause chain is preserved, so operators still see
      //    "what was being attempted" above the RPC failure. This runs
      //    across EVERY log call that passes `{ err }` — not just HTTP
      //    handlers — because the leak applies to any logger consumer
      //    that passes an RPC error. The same sanitiser fires inside
      //    `@polygonlabs/verror`'s `serializeError` / `VError.toJSON`
      //    so persistence paths (Firestore, status routes, Sentry) are
      //    safe by default; calling it here too keeps pino's standard
      //    `err` serializer pipeline operating on a safe `Error` value.
      //
      // 2. VError.info chain-merge. VError.info() walks the full cause
      //    chain and merges info from all links, whereas stdSerializers.err
      //    only captures the top-level error's own .info. We replace the
      //    base .info with the merged chain (omitting the key entirely
      //    when the chain has no info) so callers always get the full
      //    context. VError.info() duck-types .info so it works across
      //    module boundaries. Running this on the sanitised clone means
      //    the merged info reflects the sanitised per-node info, so
      //    `@err.info.requestUrl` in Datadog is the origin, never the
      //    full URL.
      err(err: unknown) {
        const safeErr: unknown = sanitiseEthersFetchError(err) ?? err;

        const base = stdSerializers.err(safeErr as Error);
        if (safeErr instanceof Error) {
          const merged = VError.info(safeErr as VError);
          const { info: _dropped, ...rest } = base as Record<string, unknown>;
          return Object.keys(merged).length > 0 ? { ...rest, info: merged } : rest;
        }
        return base;
      }
    },
    hooks: {
      logMethod(args, method, level) {
        const first = args[0];
        if (first !== null && typeof first === 'object' && 'err' in (first as object)) {
          const obj = first as Record<string, unknown>;
          if (obj['err'] instanceof Error) {
            // Unwrap WError chain — WError's own message is never the useful signal.
            // Use WERROR_SYMBOL (Symbol.for) instead of instanceof — works across
            // module boundaries regardless of how many copies of @polygonlabs/verror
            // are loaded.
            let err: Error = obj['err'];
            while ((err as unknown as Record<symbol, unknown>)[WERROR_SYMBOL] === true) {
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
