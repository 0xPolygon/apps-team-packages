---
'@polygonlabs/zod-to-openapi-heyapi': patch
---

Fix codec round-trip on the request side and own the public SDK surface end-to-end.

The plugin already decoded codec-typed responses on receipt (`Int64Codec` wire string → `bigint`, `IsoDateCodec` wire string → `Date`). Outgoing requests didn't get the symmetric treatment, so callers had to pass wire-shaped values for path / query / body parameters — and worse, `IsoDateCodec` on a path or query parameter didn't round-trip at all (`String(date)` is the locale string, not ISO 8601, and the server rejects it). This release closes that gap:

- For routes whose `request.{params, query, body}` ZodObject is exported from `schemasFrom`, the plugin now emits a runtime-shaped `${Op}Input` type and a per-op transformer that runs `z.encode(schema, value)` before the request is serialised. Callers pass `bigint` / `Date` / etc.; the wire format goes onto the URL or into the body.
- Input slot names are resolved by **identity lookup** against `schemasFrom`'s named exports — no `.openapi('Name')` chain or `register()` call is required for inputs. Use the same instance in the route as you export. (Response schemas still need `.openapi('Name')` because the OpenAPI generator uses it to lift them into `components.schemas` and emit `$ref`.)
- Per-slot optionality is mirrored from hey-api's `${Op}Data`. A route whose query schema has only optional fields emits `query?: ...` in `${Op}Input` and `options?:` on the wrapper, so `listMessages()` with no args works. Routes with a required path slot still demand `(options: { path: { ... } })` at the call site.
- The plugin emits one canonical SDK function per operation — codec-bearing ops get the encoding wrapper, everything else gets a zero-overhead re-binding of the upstream `@hey-api/sdk` emission. Both flow through `registry-validator.gen.ts` so the consumer's import surface is uniform and unambiguous.
- The codegen-time audit covers input schemas as well as responses — input slots whose ZodType isn't a named export of `schemasFrom` silently skip encoding (anonymous inline params), and named exports are guaranteed-importable by construction.

Required setup change: pass `transformer: true, includeInEntry: false` on the `@hey-api/sdk` plugin entry. Both are non-negotiable now — the registry plugin owns the public SDK surface (so `@hey-api/sdk`'s same-named raw functions must stay out of the auto-generated entry barrel) and wires its `${opId}Transformer` symbols via the SDK plugin's `transformer` hook (so without it response decode silently doesn't run). The plugin throws a clear, actionable error at codegen time if either is misconfigured, with the exact before/after config to write — so misconfiguration surfaces immediately rather than as a confusing duplicate-export TS error or a silent type/runtime divergence downstream.

Headers are out of scope this iteration; documented as a follow-up in the README.
