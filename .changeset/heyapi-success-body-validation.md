---
'@polygonlabs/zod-to-openapi-heyapi': patch
---

Report 2xx bodies that fail response validation as `ResponseValidationError` instead of `TransportError`

## Fixed

- A success (2xx) response body that failed `parseAsync` against the registered response schema surfaced as a `TransportError` — the response transformer's `ZodError` was intercepted by the SDK wrapper's generic `instanceof Error` transport branch, so the single most important thing the codec client detects (a producer's contract drift on a success body) was reported as a network failure. It now surfaces as a `ResponseValidationError` carrying the parse issues (`cause`) and the offending post-`JSON.parse` body (`body`), in both `throwOnError` modes and for every wrapper flavour — full error-decoding wrappers, input-only wrappers, and pass-through ops.

## Docs

- `schemasFrom: '#schemas'` (a `package.json#imports` alias) was documented but has never worked: Node resolves `#` aliases against the package containing the importing module, and the plugin dynamic-imports `schemasFrom` from its own install location, where the consumer's alias is not defined. The README, option JSDoc, and the codegen-time error hint now describe the working pattern for schemas living inside the codegen package — give the package a `name` + `exports` entry, self-link it (`"<name>": "link:."` in devDependencies), and pass the package's own name.
