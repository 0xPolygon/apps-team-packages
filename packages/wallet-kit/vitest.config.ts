import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vite 7's SSR resolver (the path Vitest uses for Node tests) ignores
  // top-level `resolve.conditions`; `@polygonlabs/source` has to go under
  // `ssr.resolve.conditions` for workspace packages to resolve to `.ts`
  // source without a built `dist/`.
  ssr: {
    resolve: {
      conditions: ['@polygonlabs/source']
    }
  },
  resolve: {
    conditions: ['@polygonlabs/source']
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx']
  }
});
