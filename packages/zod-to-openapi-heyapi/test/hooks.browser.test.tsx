// Headless-Chromium hook integration tests.
//
// Runs under `@vitest/browser` (Playwright provider) so the codec
// pipeline executes in an actual browser — same fetch, same XHR,
// same module resolution as the consumer app. MSW intercepts via the
// service worker (`public/mockServiceWorker.js`); installing the
// worker is the one piece of test plumbing that differs from the
// node-side suites.
//
// Why headless browser instead of jsdom: jsdom + msw/node doesn't
// reliably intercept the upstream tanstack factory's `queryFn` fetch
// calls — the fetch global the factory reaches for is the jsdom
// polyfill, while msw/node patches Node's fetch. Hooks ARE a
// browser-runtime concern; mocking the wire layer at the same layer
// (the service worker) is the way the consumer's runtime actually
// works.
//
// Coverage matrix: same shape as `api-errors.test.ts` (transport /
// unknown / typed × throwOnError) but pulled through `useQuery` and
// `useMutation` so we verify the React lifecycle wires up correctly
// (loading → success → error transitions, mutation.error / query.error
// population, no `as` casts for narrowing).

import type { HttpHandler } from 'msw';
import type { ReactNode } from 'react';

import { QueryClient, QueryClientProvider, useMutation, useQuery } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupWorker } from 'msw/browser';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  client,
  createOrFetchResource,
  getScalarStringOptions,
  isTransportError,
  isResponseValidationError,
  isWrapperError,
  lookupBlockOptions
} from './public-client.ts';

const BASE_URL = 'http://api.test';
const worker = setupWorker();

beforeAll(async () => {
  client.setConfig({ baseUrl: BASE_URL });
  // Quiet mode so the service worker's registration log doesn't
  // pollute test output. The unhandled-request callback ignores the
  // vitest browser harness's own internal traffic so a missing
  // user-handler still surfaces as an error.
  await worker.start({
    quiet: true,
    onUnhandledRequest: (request) => {
      if (!request.url.startsWith(BASE_URL)) return;
      throw new Error(`MSW: unhandled request: ${request.method} ${request.url}`);
    }
  });
});

afterEach(() => {
  worker.resetHandlers();
  client.setConfig({ throwOnError: false, responseStyle: 'fields' });
});

afterAll(() => {
  worker.stop();
});

// ── Test harness ─────────────────────────────────────────────────────────────

/**
 * Fresh `QueryClient` + provider per render. Default retries off and
 * `gcTime: 0` so each test sees a clean cache and no retry timeout
 * eats the assertion window.
 */
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false }
    }
  });
}

/**
 * Typed wrapper around RTL's `renderHook` that always wires the query
 * client provider — every hook test needs it; repeating it inline is
 * noise.
 */
function renderApiHook<T>(useHook: () => T) {
  const queryClient = makeQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(useHook, { wrapper });
}

/** One-shot installer for an MSW handler so the test stays linear. */
function use(...handlers: HttpHandler[]): void {
  worker.use(...handlers);
}

// ── 1. useQuery via the upstream factory (raw SDK) ──────────────────────────

describe('useQuery via upstream factory (non-codec op)', () => {
  it('populates `data` after a successful response', async () => {
    use(
      http.get(`${BASE_URL}/fixtures/getScalarString`, () =>
        HttpResponse.json({ value: 'hello-from-hook' })
      )
    );

    const { result } = renderApiHook(() => useQuery(getScalarStringOptions()));
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data).toEqual({ value: 'hello-from-hook' });
    expect(result.current.error).toBeNull();
  });

  it('populates `error` (raw HTTP body, NOT a wrapper-error) when the server returns 500', async () => {
    // Upstream factory's queryFn calls the raw SDK with
    // `throwOnError: true`; the SDK throws the wire-shape body.
    // Because the wrapper isn't in this path, `query.error` is the
    // raw value, NOT a TransportError / ResponseValidationError. This is the
    // current behaviour — pin it so a future change to route the
    // upstream factory through the wrapper surfaces as a flipped
    // assertion, not a silent narrowing change.
    use(
      http.get(`${BASE_URL}/fixtures/getScalarString`, () =>
        HttpResponse.json({ wire: 'shape' }, { status: 500 })
      )
    );

    const { result } = renderApiHook(() => useQuery(getScalarStringOptions()));
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(isWrapperError(result.current.error)).toBe(false);
  });
});

// ── 2. useQuery via the codec-aware factory ────────────────────────────────

describe('useQuery via codec-aware factory', () => {
  it('decodes codec response fields end-to-end (Int64Codec → bigint)', async () => {
    let urlSeen: string | undefined;
    use(
      http.get(`${BASE_URL}/fixtures/blocks/:blockNumber`, ({ request }) => {
        urlSeen = request.url;
        return HttpResponse.json({ value: 'block-data' });
      })
    );

    const { result } = renderApiHook(() =>
      useQuery(lookupBlockOptions({ path: { blockNumber: 9007199254740993n } }))
    );
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data).toEqual({ value: 'block-data' });
    expect(urlSeen).toContain('/fixtures/blocks/9007199254740993');
  });

  it('reports `error` on a transport failure', async () => {
    use(http.get(`${BASE_URL}/fixtures/blocks/:blockNumber`, () => HttpResponse.error()));

    const { result } = renderApiHook(() =>
      useQuery(lookupBlockOptions({ path: { blockNumber: 1n } }))
    );
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    // Same caveat as the upstream factory: codec-aware factory's
    // queryFn also calls the raw SDK, so the thrown native Error
    // reaches `query.error` unwrapped.
    expect(result.current.error).toBeInstanceOf(Error);
  });
});

// ── 3. useMutation via the imperative wrapper (full narrowing) ─────────────

describe('useMutation via imperative wrapper', () => {
  // The mutation calls the wrapper via `await createOrFetchResource(...)`,
  // so `mutation.error` carries the wrapper-narrowed shape (typed
  // `${Op}Error` | TransportError | ResponseValidationError). Tests cover all
  // three categories + the success path.

  function useCreateOrFetchMutation() {
    return useMutation({
      mutationFn: async () => {
        const r = await createOrFetchResource();
        if (r.error) throw r.error;
        if (!r.data) throw new Error('createOrFetchResource returned no data');
        return r.data;
      }
    });
  }

  it('populates `data` after a successful 201 (codec round-trip on createdAt)', async () => {
    use(
      http.post(`${BASE_URL}/fixtures/createOrFetch`, () =>
        HttpResponse.json({ id: 'res_1', createdAt: '2026-04-28T14:00:00Z' }, { status: 201 })
      )
    );

    const { result } = renderApiHook(() => useCreateOrFetchMutation());
    result.current.mutate();
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    const data = result.current.data;
    if (!data || !('createdAt' in data)) {
      throw new Error('expected ResourceCreated branch with createdAt');
    }
    expect(data.createdAt).toBeInstanceOf(Date);
  });

  it('lands a TransportError on `mutation.error` when fetch rejects', async () => {
    use(http.post(`${BASE_URL}/fixtures/createOrFetch`, () => HttpResponse.error()));

    const { result } = renderApiHook(() => useCreateOrFetchMutation());
    result.current.mutate();
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    if (!isTransportError(result.current.error)) {
      throw new Error(`expected TransportError, got ${describeError(result.current.error)}`);
    }
    expect(result.current.error.cause).toBeInstanceOf(Error);
  });

  it('lands an ResponseValidationError on `mutation.error` when the body is schema-mismatched', async () => {
    const badBody = { unexpected: 'shape' };
    use(
      http.post(`${BASE_URL}/fixtures/createOrFetch`, () =>
        HttpResponse.json(badBody, { status: 500 })
      )
    );

    const { result } = renderApiHook(() => useCreateOrFetchMutation());
    result.current.mutate();
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    if (!isResponseValidationError(result.current.error)) {
      throw new Error(
        `expected ResponseValidationError, got ${describeError(result.current.error)}`
      );
    }
    expect(result.current.error.body).toEqual(badBody);
  });

  it('lands a typed `${Op}Error` on `mutation.error` (codec round-trip on traceId)', async () => {
    use(
      http.post(`${BASE_URL}/fixtures/createOrFetch`, () =>
        HttpResponse.json(
          { code: 'internal_error', message: 'kaboom', traceId: '7' },
          { status: 500 }
        )
      )
    );

    const { result } = renderApiHook(() => useCreateOrFetchMutation());
    result.current.mutate();
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    const surfaced = result.current.error;
    expect(isWrapperError(surfaced)).toBe(false);
    if (surfaced && typeof surfaced === 'object' && 'traceId' in surfaced) {
      expect(typeof surfaced.traceId).toBe('bigint');
      expect(surfaced.traceId).toBe(7n);
    } else {
      throw new Error(`expected ServerError branch, got ${describeError(surfaced)}`);
    }
  });
});

function describeError(v: unknown): string {
  if (v instanceof Error) return `${v.constructor.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
