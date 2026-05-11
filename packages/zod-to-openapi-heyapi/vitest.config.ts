import { defineConfig } from 'vitest/config';

// Two test surfaces:
//
//   - **node**: codegen-emit assertions, type tests, MSW-backed
//     imperative API tests. Runs fast, no browser overhead. The
//     `.test.ts` extension routes here by exclusion (everything that
//     isn't a `.tsx` test file).
//   - **browser**: React hook integration tests (`*.browser.test.tsx`)
//     in a real headless Chromium via Playwright. Closes the
//     SSR/jsdom-ergonomic gap — consumers ship to the browser, not
//     to a Node polyfill, so the binding contract this plugin
//     promises (TanStack hooks consume the codec-aware factories,
//     wrappers narrow errors, MSW mocks the wire layer) only matters
//     if it works in an actual browser. jsdom + msw/node interop is
//     fiddly and fails to intercept the upstream factory's queryFn
//     fetch calls; Chromium + msw/browser (service worker) is the
//     real-world surface.
export default defineConfig({
  // Browser-mode tests need MSW's service worker file served at
  // `/mockServiceWorker.js`. Vite serves whatever's under `publicDir`
  // as static content at the URL root; the default is `public/`, but
  // the team's plugin package has no other use for a `public/`
  // directory — naming it that just because it's the MSW docs'
  // example convention misleads anyone looking at the repo for the
  // first time. Co-locating the service worker under `test/__msw__/`
  // mirrors Jest's `__snapshots__` / `__mocks__` test-only-directory
  // idiom so the artifact's purpose is obvious from the path.
  //
  // `msw.workerDirectory` in package.json is set to the same path —
  // that's the input MSW's auto-update postinstall hook reads when
  // refreshing the worker after an `msw` package bump.
  publicDir: 'test/__msw__',
  // Vite 7's SSR resolver (the path Vitest uses for Node tests) ignores
  // top-level `resolve.conditions`; the `@polygonlabs/source` condition
  // has to go under `ssr.resolve.conditions` for workspace packages to
  // resolve to `.ts` source without a built `dist/`.
  ssr: {
    resolve: {
      conditions: ['@polygonlabs/source']
    }
  },
  resolve: {
    // Mirror the SSR conditions on the browser-mode resolver so source
    // imports work the same way under Chromium.
    conditions: ['@polygonlabs/source']
  },
  esbuild: {
    // Auto JSX so `.tsx` test files don't need explicit React imports.
    jsx: 'automatic'
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.test.ts']
        }
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['test/**/*.browser.test.tsx'],
          browser: {
            enabled: true,
            provider: 'playwright',
            headless: true,
            instances: [{ browser: 'chromium' }]
          }
        }
      }
    ]
  }
});
