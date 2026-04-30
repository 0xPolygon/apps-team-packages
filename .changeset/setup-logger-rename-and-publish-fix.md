---
'@polygonlabs/express': patch
---

Rename `requestContext` to `setupLogger` and republish so `dist/notFound.*`
makes it into the npm tarball.

The `requestContext` export read like a no-op middleware factory and hid the
`getLogger()` fallback-priming side effect — the test/script gotcha
documented in the README came from readers missing that the same call both
mounts the per-request middleware and primes the out-of-request fallback.
`setupLogger(logger)` surfaces that intent. The function's behaviour is
unchanged; only the name and the `getLogger()` error-message text changed.

Shipping as a patch despite being a breaking import: 1.0.0's published
tarball was missing `dist/notFound.*`, so the documented import graph
(`import { notFoundHandler } from '@polygonlabs/express'`) blew up at module
load for any consumer. Renaming alongside the republish avoids spending a
major bump on a name nobody could have actually used.
