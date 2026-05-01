---
'@polygonlabs/apps-team-lint': minor
---

Add `polygon/no-discarded-typed-registry-chain` rule to the `typescript()` preset.

Catches the partial-discard case in `@polygonlabs/openapi-registry`'s chainable API that the type-level `OperationsOf<F>` brand can't detect: `r.registerPath({…});` (or `.registerSecurityScheme(…)`, or `.with(…)`) in expression-statement position on a `TypedRegistry` receiver still mutates the underlying registry at runtime, but the type-level narrow is dropped — downstream consumers reading `OperationsOf<typeof buildRegistry>` see a manifest with that operation missing, even though the OpenAPI spec contains it. The rule is type-aware (uses `parserServices` from the existing `projectService: true` setup) so it only fires on `TypedRegistry` receivers — same-named methods on unrelated classes are not flagged.

The rule is enabled at `'error'` severity in the `typescript()` preset, so consuming repos pick it up automatically when they update.

To opt out for a deliberate test fixture (e.g. demonstrating the failure mode), add a scoped `eslint-disable polygon/no-discarded-typed-registry-chain` directive with a `--` comment explaining why.
