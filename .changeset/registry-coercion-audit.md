---
'@polygonlabs/openapi-registry': major
---

`registerPath` now rejects coercing schemas (`z.coerce.*`) in parameter positions

## Breaking change

`TypedRegistry.registerPath` throws at generate time when `request.params`, `request.query`, or `request.headers` contains a coercing schema (`z.coerce.number()`, `z.coerce.date()`, …), including when wrapped in `.optional()` / `.default()` / `.nullable()`.

Why: in zod v4 a coercing schema's input type is `unknown`, so the generated OpenAPI marks the parameter `required: false, nullable: true` regardless of the author's intent — a required parameter silently documents as optional-and-nullable, and every codegen consumer inherits the misdocumented contract. The audit turns that silent corruption into a loud error on the engineer's machine, in the same spirit as the sealed shared-registry conflict check.

## Migration

- Parameter converted by the server binding: declare the logical type plainly — `z.coerce.number().int()` → `z.number().int()`.
- Wire string with a different runtime type: use a codec that declares both sides — e.g. `Int64Codec` / `IsoDateCodec` from `@polygonlabs/zod-codecs`. Codecs (`z.codec(...)`) are unaffected by the audit.
- Request bodies are not audited — JSON bodies carry typed values on the wire.

The check is also exported directly as `assertNoCoercingParamSchemas` for use outside `TypedRegistry`.
