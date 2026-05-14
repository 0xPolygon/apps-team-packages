---
'@polygonlabs/zod-to-openapi-heyapi': minor
---

Complete the auto-generated `index.ts` as the canonical consumer
surface.

`defineRegistryClientConfig` now sets `includeInEntry: true` on
`@hey-api/client-fetch` (so the singleton `client` reaches the
auto-barrel) and on `@tanstack/react-query` (so non-codec ops'
`${Op}Options` / `${Op}QueryKey` factories and codec ops'
`${Op}Mutation` factories reach it too). The upstream tanstack
plugin's colliding `QueryKey` alias is suppressed via a predicate so
this plugin's canonical `QueryKey<TOptions>` is the only one in the
entry.

Before this change, consumer packages wiring up their public surface
had to hand-roll re-exports from `client.gen.ts` and
`@tanstack/react-query.gen.ts` to fill the gap — encoding internal
codegen file layout in the consumer's hand-written barrel. The split
across multiple `*.gen.ts` files (one canonical name per op id, but
across files chosen by codec status / HTTP verb) is non-intuitive
and shouldn't be something the consumer has to understand.

The result: a publishable client package's hand-written barrel can
re-export from `./generated/index.js` without ever naming a
`*.gen.ts` path. See `apps-team-ts-template/packages/example-client/src/index.ts`
for the reference shape.
