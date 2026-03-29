---
"@polygonlabs/logger": patch
---

`Logger`, `Level`, and `DestinationStream` types are now exported directly from `@polygonlabs/logger`.

Previously, consumers needed to `import type { Logger } from 'pino'` to type-annotate logger instances,
requiring a direct pino dependency. All three types are now re-exported from the package so consumers
can import them from `@polygonlabs/logger` without adding pino as an explicit dependency.

`createLogger` now also handles a missing `pino-pretty` gracefully: if `pretty: true` is passed but
`pino-pretty` is not installed, the logger falls back to JSON output and emits a warning rather than
throwing an import error.
