export { createLogger } from './logger.ts';
export type { CreateLoggerOptions, SentryAdapter } from './logger.ts';
// Re-export from `@polygonlabs/verror`, where it now lives — the function is
// an Error primitive (alongside `cause`, `info`, `fullStack`), not a logger
// concern. Keeping the re-export means existing import sites
// (`@polygonlabs/express`, services that wire it manually) keep working
// without a code change.
export { sanitiseEthersFetchError } from '@polygonlabs/verror';
export type { DestinationStream, Level, Logger } from 'pino';
