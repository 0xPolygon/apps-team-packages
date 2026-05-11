// Test-suite "public" surface for the generated client.
//
// Mirrors how a real consumer wires the codegen output into a
// publishable package (cf. `apps-team-ts-template/packages/example-client/
// src/index.ts`): re-export the auto-generated barrel and add the
// runtime `client` for baseUrl configuration. Tests import only from
// this file, never from the deep `__generated__/<file>.gen.ts` paths.
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
// Codec-aware factories live in `registry-validator.gen.ts`; the
// upstream tanstack plugin's factories live in
// `@tanstack/react-query.gen.ts`. Both flow through the barrel —
// only the upstream factories that aren't re-exported (because
// they're not codec-bearing) need a separate import path. We
// re-export them here too so tests don't reach into the
// `@tanstack/...` subpath either.

export * from './__generated__/index.ts';
export {
  // Upstream tanstack-plugin factories for non-codec ops. Not
  // re-exported by hey-api's auto-barrel because they live in a
  // sibling file; consumers depending on TanStack Query typically
  // re-export them themselves (see example-client/src/react.ts in
  // apps-team-ts-template).
  getScalarStringOptions,
  getScalarStringQueryKey
} from './__generated__/@tanstack/react-query.gen.ts';
// `client` is the runtime singleton consumers configure with
// baseUrl / fetch hooks at app startup. Not part of the per-op
// barrel; lives in client.gen.ts.
export { client } from './__generated__/client.gen.ts';
