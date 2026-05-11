// Test-suite "public" surface for the generated client.
//
// Mirrors how a real consumer wires the codegen output into a
// publishable package (cf. `apps-team-ts-template/packages/example-client/
// src/index.ts`): re-export the auto-generated barrel — and nothing
// else. Tests import only from this file, never from the deep
// `__generated__/<file>.gen.ts` paths.
//
// Why this matters: the auto-generated barrel `__generated__/index.ts`
// is owned by hey-api, and the symbols it re-exports are a contract
// between the plugin and any consumer. If a plugin change emits a
// new helper but forgets to publish it through the barrel, deep
// imports in our tests would still pass — and a real consumer would
// break on `import { foo } from '@my-org/api-client'`. Routing
// every test through this file (and the barrel) keeps the test
// surface aligned with the consumer surface, so plugin-level
// regressions in re-exports surface here instead of downstream.
//
// `defineRegistryClientConfig` configures the upstream
// `@hey-api/client-fetch` and `@tanstack/react-query` plugins with
// `includeInEntry: true`, so the singleton `client`, non-codec ops'
// `${Op}Options` / `${Op}QueryKey` factories, and codec ops'
// `${Op}Mutation` factories all flow through the auto-barrel
// alongside the codec-aware emissions from `registry-validator.gen.ts`.
// One canonical entry, no deep paths.
export * from './__generated__/index.ts';
