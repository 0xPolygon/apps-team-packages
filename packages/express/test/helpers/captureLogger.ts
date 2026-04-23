import { Writable } from 'node:stream';

import type { Logger } from '@polygonlabs/logger';

import { createLogger } from '@polygonlabs/logger';

/**
 * A single emitted log entry, parsed from the pino destination stream.
 * Fields mirror what `@polygonlabs/logger` writes:
 *
 * - `level` — string label ("debug", "info", …) via the logger's custom
 *   level formatter.
 * - `message` — pino's `msg` output key is renamed to `message` for Datadog
 *   ingestion (see `packages/logger/src/logger.ts`).
 * - `timestamp` — ISO 8601 string.
 * - Any bindings attached via `.child({ requestId })` or the log call's
 *   merge object appear as additional top-level keys.
 */
export interface Captured {
  level: string;
  message?: string;
  timestamp?: string;
  [k: string]: unknown;
}

/**
 * Returns a real `@polygonlabs/logger` instance whose output is captured in
 * memory. Uses the logger factory's `destination` option (intended for
 * exactly this purpose) so tests exercise the actual logger — serialisers,
 * child-logger bindings, VError unwrap, the `message` key rename — rather
 * than a hand-rolled pino-shaped stub whose `.child()` was a no-op.
 *
 * `captured` is appended to every time the logger (or any of its children)
 * emits an entry. Because pino serialises lines, assertions can inspect the
 * parsed JSON shape directly.
 */
export async function makeCaptureLogger(): Promise<{
  logger: Logger;
  captured: Captured[];
}> {
  const captured: Captured[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      try {
        captured.push(JSON.parse(chunk.toString()) as Captured);
      } catch {
        // Ignore non-JSON lines (should not happen with our logger config).
      }
      cb();
    }
  });
  const logger = await createLogger({ destination: stream });
  return { logger, captured };
}
