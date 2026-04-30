# @polygonlabs/zod-to-openapi-heyapi

## 1.1.1

### Patch Changes

- 8452fe8: Fix codec round-trip on the request side and own the public SDK surface end-to-end.

  The plugin already decoded codec-typed responses on receipt (`Int64Codec` wire string → `bigint`, `IsoDateCodec` wire string → `Date`). Outgoing requests didn't get the symmetric treatment, so callers had to pass wire-shaped values for path / query / body parameters — and worse, `IsoDateCodec` on a path or query parameter didn't round-trip at all (`String(date)` is the locale string, not ISO 8601, and the server rejects it). This release closes that gap:
  - For routes whose `request.{params, query, body}` ZodObject is exported from `schemasFrom`, the plugin now emits a runtime-shaped `${Op}Input` type and a per-op transformer that runs `z.encode(schema, value)` before the request is serialised. Callers pass `bigint` / `Date` / etc.; the wire format goes onto the URL or into the body.
  - Input slot names are resolved by **identity lookup** against `schemasFrom`'s named exports — no `.openapi('Name')` chain or `register()` call is required for inputs. Use the same instance in the route as you export. (Response schemas still need `.openapi('Name')` because the OpenAPI generator uses it to lift them into `components.schemas` and emit `$ref`.)
  - Per-slot optionality is mirrored from hey-api's `${Op}Data`. A route whose query schema has only optional fields emits `query?: ...` in `${Op}Input` and `options?:` on the wrapper, so `listMessages()` with no args works. Routes with a required path slot still demand `(options: { path: { ... } })` at the call site.
  - The plugin emits one canonical SDK function per operation — codec-bearing ops get the encoding wrapper, everything else gets a zero-overhead re-binding of the upstream `@hey-api/sdk` emission. Both flow through `registry-validator.gen.ts` so the consumer's import surface is uniform and unambiguous.
  - The codegen-time audit covers input schemas as well as responses — input slots whose ZodType isn't a named export of `schemasFrom` silently skip encoding (anonymous inline params), and named exports are guaranteed-importable by construction.

  Required setup change: pass `transformer: true, includeInEntry: false` on the `@hey-api/sdk` plugin entry. Both are non-negotiable now — the registry plugin owns the public SDK surface (so `@hey-api/sdk`'s same-named raw functions must stay out of the auto-generated entry barrel) and wires its `${opId}Transformer` symbols via the SDK plugin's `transformer` hook (so without it response decode silently doesn't run). The plugin throws a clear, actionable error at codegen time if either is misconfigured, with the exact before/after config to write — so misconfiguration surfaces immediately rather than as a confusing duplicate-export TS error or a silent type/runtime divergence downstream.

  Headers are out of scope this iteration; documented as a follow-up in the README.

## 1.1.0

### Minor Changes

- 20d74b0: Narrow the codegen-time audit to schemas actually `$ref`d from a route response.

  The previous audit walked every entry under `components.schemas` and demanded a matching named export from `schemasFrom` for each. That over-approximated the import set the plugin actually emits — the generated client only imports response schemas, never request bodies, internal building blocks, or registered path / query parameters. zod-to-openapi v8's `OpenApiGeneratorV3` lifts parameter schemas into both `components.parameters` and `components.schemas`, so a route registered with `registry.registerParameter('network', ...)` would trip the audit demanding a Zod export named `network` even though the plugin never imports it.

  The audit now walks `paths.*.responses.*.content.*.schema.$ref` to determine which schemas need exports — exactly the set the plugin emits `import { Name } from '<schemasFrom>'` for. Parameter-only schemas, request body schemas, and unreferenced building blocks are silently ignored.

  The audit's other guarantees are unchanged: response schemas must be named exports under their registered names, and the export must be a Zod schema (duck-typed). Aggregated multi-issue errors still report every problem in one pass.

  Other improvements:
  - Sharper `ERR_MODULE_NOT_FOUND` error message when `await import(schemasFrom)` fails: explicitly calls out the most common causes (package not installed, custom export condition not active, relative path passed) so the developer doesn't have to guess.
  - README rewrite covering the new audit semantics, the cross-package vs. same-package distinction for `schemasFrom` (only `#imports` aliases work for same-package; cross-package uses the package name), the `.openapi()` chaining caveat for codecs imported from another package, the DOM-globals / `undici-types` workaround for Node consumers, the `@hey-api/client-fetch` deprecation FAQ (don't install separately — it's vendored into `@hey-api/openapi-ts`'s output), the `as never` cast explanation, the `.gitattributes` recommendation for committed generated code, the `sonar-project.properties` exclusions for static-analysis tooling, and a migration section covering `*Schema`-suffixed exports and the move from orval / openapi-typescript / `@hey-api/zod`.
  - Drop `@hey-api/client-fetch` from the plugin's `devDependencies` — the generated fixtures vendor the fetch client locally, so the explicit dep was unused.

## 1.0.0

### Major Changes

- 5a1c428: Initial release of `@polygonlabs/zod-to-openapi-heyapi`: a `@hey-api/openapi-ts` plugin that sources Zod schemas — including codecs — from a `@asteasolutions/zod-to-openapi` `OpenAPIRegistry` rather than regenerating them from the spec.

  Generated clients import the actual Zod schemas, gaining two things the standard `@hey-api/typescript` plugin can't provide:
  - **Codec-correct response types.** Each operation's response is emitted as `z.output<typeof Schema>`, so codec output types reach the caller. A `z.codec(z.string(), z.bigint(), …)` field is typed as `bigint` (the runtime value) instead of `string` (the wire format).
  - **Per-operation transformer functions** that call `Schema.parseAsync(data)`. `@hey-api/client-fetch` wires these as `responseTransformer`, so codec decode (`"1500.50"` → `1500n`, ISO string → `Date`, …) runs automatically before the value reaches the caller.

  The plugin works for every Zod construct `z.infer` supports — tuples, intersections, discriminated unions, lazy/recursive types, dates, sets/maps, defaults, branded types — by delegating to TypeScript's own resolution of Zod's type machinery rather than re-implementing it.
