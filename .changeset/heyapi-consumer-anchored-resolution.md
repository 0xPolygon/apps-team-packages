---
'@polygonlabs/zod-to-openapi-heyapi': minor
---

`schemasFrom` now resolves from the consumer's perspective — `'#schemas'` aliases work

The codegen-time audit used to dynamic-import `schemasFrom` with the plugin's own install location as the resolution referrer, so a consumer's `package.json#imports` alias (`'#schemas'`) could never resolve — the documented same-package recipe failed for every real installation, while bare package names worked only via the package manager's store layout. The audit now anchors resolution at the codegen **output directory** — the exact location the generated client's emitted `import { Name } from '<schemasFrom>'` statements resolve from — so audit-time and consumer-runtime resolution are identical by construction, including `imports` aliases with their conditions, `exports` maps, and the running process's `--conditions` flags.

- `'#schemas'` is the canonical `schemasFrom` for schemas living in the same package as the codegen: declare the alias under `imports` and point it at the schema barrel. No package `name`, `exports` entry, or self-dependency is needed.
- **If you adopted the `"<name>": "link:."` self-dependency workaround** from the 2.0.4 docs: remove the self-link (and the `exports` entry, if nothing else consumes it) and switch `schemasFrom` to a `#` alias.
- Package specifiers (`@org/pkg`, `@org/pkg/zod`) for separate schemas packages are unchanged.
- Relative paths are now rejected with guidance instead of being undefined behavior: the emitted import must resolve identically from anywhere in the consumer package, which only aliases and package names do.
- `registryPlugin` (the advanced API) gains an optional `outputDir` option; `defineRegistryClientConfig` wires it automatically from `output`.
