# @polygonlabs/zod-to-openapi-heyapi

## 1.0.0

### Major Changes

- 5a1c428: Initial release of `@polygonlabs/zod-to-openapi-heyapi`: a `@hey-api/openapi-ts` plugin that sources Zod schemas — including codecs — from a `@asteasolutions/zod-to-openapi` `OpenAPIRegistry` rather than regenerating them from the spec.

  Generated clients import the actual Zod schemas, gaining two things the standard `@hey-api/typescript` plugin can't provide:
  - **Codec-correct response types.** Each operation's response is emitted as `z.output<typeof Schema>`, so codec output types reach the caller. A `z.codec(z.string(), z.bigint(), …)` field is typed as `bigint` (the runtime value) instead of `string` (the wire format).
  - **Per-operation transformer functions** that call `Schema.parseAsync(data)`. `@hey-api/client-fetch` wires these as `responseTransformer`, so codec decode (`"1500.50"` → `1500n`, ISO string → `Date`, …) runs automatically before the value reaches the caller.

  The plugin works for every Zod construct `z.infer` supports — tuples, intersections, discriminated unions, lazy/recursive types, dates, sets/maps, defaults, branded types — by delegating to TypeScript's own resolution of Zod's type machinery rather than re-implementing it.
