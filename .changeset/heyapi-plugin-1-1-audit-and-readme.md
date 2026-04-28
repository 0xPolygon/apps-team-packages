---
'@polygonlabs/zod-to-openapi-heyapi': minor
---

Narrow the codegen-time audit to schemas actually `$ref`d from a route response.

The previous audit walked every entry under `components.schemas` and demanded a matching named export from `schemasFrom` for each. That over-approximated the import set the plugin actually emits — the generated client only imports response schemas, never request bodies, internal building blocks, or registered path / query parameters. zod-to-openapi v8's `OpenApiGeneratorV3` lifts parameter schemas into both `components.parameters` and `components.schemas`, so a route registered with `registry.registerParameter('network', ...)` would trip the audit demanding a Zod export named `network` even though the plugin never imports it.

The audit now walks `paths.*.responses.*.content.*.schema.$ref` to determine which schemas need exports — exactly the set the plugin emits `import { Name } from '<schemasFrom>'` for. Parameter-only schemas, request body schemas, and unreferenced building blocks are silently ignored.

The audit's other guarantees are unchanged: response schemas must be named exports under their registered names, and the export must be a Zod schema (duck-typed). Aggregated multi-issue errors still report every problem in one pass.

Other improvements:

- Sharper `ERR_MODULE_NOT_FOUND` error message when `await import(schemasFrom)` fails: explicitly calls out the most common causes (package not installed, custom export condition not active, relative path passed) so the developer doesn't have to guess.
- README rewrite covering the new audit semantics, the cross-package vs. same-package distinction for `schemasFrom` (only `#imports` aliases work for same-package; cross-package uses the package name), the `.openapi()` chaining caveat for codecs imported from another package, the DOM-globals / `undici-types` workaround for Node consumers, the `@hey-api/client-fetch` deprecation FAQ (don't install separately — it's vendored into `@hey-api/openapi-ts`'s output), the `as never` cast explanation, the `.gitattributes` recommendation for committed generated code, the `sonar-project.properties` exclusions for static-analysis tooling, and a migration section covering `*Schema`-suffixed exports and the move from orval / openapi-typescript / `@hey-api/zod`.
- Drop `@hey-api/client-fetch` from the plugin's `devDependencies` — the generated fixtures vendor the fetch client locally, so the explicit dep was unused.
