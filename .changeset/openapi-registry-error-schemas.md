---
'@polygonlabs/openapi-registry': minor
---

Add `@polygonlabs/openapi-registry/error-schemas` subpath exporting the
canonical Zod schemas for the standard error response shapes
(`ErrorResponseSchema`, `ValidationErrorResponseSchema`,
`ValidationErrorInfoSchema`, `ZodErrorTreeSchema`).

These previously lived only inside `@polygonlabs/express/registry`, which
forced schemas-only consumers to take a transitive dep on Express + pino +
Sentry just to register the canonical 400 / 401 / 5xx response shapes in
their OpenAPI spec. The schemas have zero Express-runtime imports — only
`zod` and `@asteasolutions/zod-to-openapi` — so they belong with the
registry primitives.

Express 1.1.x's `@polygonlabs/express/registry` continues to re-export
them unchanged for back-compat, so existing import paths keep working.
New schemas-only packages should import from
`@polygonlabs/openapi-registry/error-schemas` directly.
