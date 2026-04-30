# Migration Guide

## 1.x

Initial release. No prior versions to migrate from.

When adopting `TypedRegistry` in a schemas package that previously used
`OpenAPIRegistry` directly:

1. Swap the import from `@asteasolutions/zod-to-openapi` to
   `@polygonlabs/openapi-registry`.
2. Add an explicit `: TypedRegistry` annotation on the variable holding
   the registry — without it, the `asserts this is X` narrowing on
   `registerPath` does not apply (TS2775).
3. Wrap composition in a function (`buildRegistry()`); the inferred
   return type is what carries the accumulated `Ops` across the export
   boundary. Top-level `export const registry = …` loses the narrow.
4. To compose per-domain helpers, use the new `.extend(fn)` method
   (statement-form, no chaining). See README.

The runtime behaviour is byte-compatible with `OpenAPIRegistry`. Every
method on the asteasolutions registry (`register`, `registerParameter`,
`registerComponent`, `registerWebhook`, `registerPath`, `definitions`)
is forwarded verbatim. The only material additions are the type-level
accumulator on `registerPath` and the `.extend(fn)` composition method.
