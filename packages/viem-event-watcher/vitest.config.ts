import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vite 7's SSR resolver (the path Vitest uses for Node tests) ignores
  // top-level `resolve.conditions`; the `@polygonlabs/source` condition
  // has to go under `ssr.resolve.conditions` for workspace packages to
  // resolve to `.ts` source without a built `dist/`. Verror itself has
  // no workspace deps today, but matching the sibling packages keeps the
  // config shape consistent across the repo.
  ssr: {
    resolve: {
      conditions: ['@polygonlabs/source']
    }
  },
  test: {
    include: ['test/**/*.test.ts']
  }
});
