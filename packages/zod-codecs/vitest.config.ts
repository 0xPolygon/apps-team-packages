import { defineConfig } from 'vitest/config';

export default defineConfig({
  ssr: {
    resolve: {
      conditions: ['@polygonlabs/source']
    }
  },
  test: {
    include: ['test/**/*.test.ts']
  }
});
