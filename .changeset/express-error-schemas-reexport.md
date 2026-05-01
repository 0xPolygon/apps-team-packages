---
'@polygonlabs/express': patch
---

`@polygonlabs/express/registry`'s error response schemas
(`ErrorResponseSchema`, `ValidationErrorResponseSchema`,
`ValidationErrorInfoSchema`, `ZodErrorTreeSchema`) now re-export from
`@polygonlabs/openapi-registry/error-schemas` rather than defining them
locally. The exported instances are unchanged — same schema objects,
same `.openapi('Name', …)` registration — so existing import paths keep
working without code changes.

The peer-dep range for `@polygonlabs/openapi-registry` is tightened to
`^1.1.0` (from `^1.0.1`) since the re-export needs the new
`./error-schemas` subpath. Consumers of `@polygonlabs/express/registry`
that were already on openapi-registry 1.0.1 should bump to 1.1.x to
avoid the peer-dep warning.

Schemas-only packages that want the canonical error response shapes
without dragging in Express + pino + Sentry should now import directly
from `@polygonlabs/openapi-registry/error-schemas`.
