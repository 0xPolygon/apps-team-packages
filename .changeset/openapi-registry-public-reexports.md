---
'@polygonlabs/openapi-registry': patch
---

Re-export `inferStandardErrorResponses`, `InferredStandardErrorResponses`,
and `MergedRoute` from the package's main entry. The auto-inject
behaviour added in 2.1.0 made `TypedRegistry.registerPath` return a type
referencing `MergedRoute` — but the type wasn't exported through the
public surface, so `tsc --declaration` in consumer packages emitted
`TS2742: The inferred type of 'buildRegistry' cannot be named without a
reference to './node_modules/@polygonlabs/openapi-registry/dist/inferErrorResponses.js'`.

Consumers using the auto-inject feature could not build their packages
against the published 2.1.0 without manually annotating chain helpers
to break the inferred reference. This patch makes the inference types
properly reachable through the package's public exports.
