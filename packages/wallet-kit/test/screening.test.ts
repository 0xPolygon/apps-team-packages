import type { Hex } from 'viem';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createScreener } from '../src/screening.ts';

const ADDRESS = '0xAbabababababababababababababababababAbAb' as Hex;
const LOWER = ADDRESS.toLowerCase() as Hex;
const API_ORIGIN = 'https://trm.example.test';
const CACHE_KEY = 'polygon-wallet-kit:wallet-screening';

const memoryStorage = (): Pick<Storage, 'getItem' | 'setItem'> => {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    }
  };
};

const mockResponse = (payload: unknown, init: { ok?: boolean; status?: number } = {}) =>
  new Response(JSON.stringify(payload), {
    status: init.status ?? (init.ok === false ? 500 : 200),
    headers: { 'content-type': 'application/json' }
  });

const ownershipRiskPayload = (categoryRiskScoreLevel: number) => [
  {
    addressRiskIndicators: [{ riskType: 'OWNERSHIP', categoryRiskScoreLevel }]
  }
];

const sanctionedPayload = ownershipRiskPayload(10);
const cleanPayload = ownershipRiskPayload(0);

const counterpartyExposurePayload = [
  {
    addressRiskIndicators: [{ riskType: 'COUNTERPARTY_EXPOSURE', categoryRiskScoreLevel: 5 }]
  }
];

describe('createScreener', () => {
  let fetchFn: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: memoryStorage()
    });
    // Default screening error handler is `console.error`; silence it
    // by default so fail-open tests don't pollute output.
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('short-circuits to false when disabled', async () => {
    const screen = createScreener({
      enabled: false,
      apiOrigin: API_ORIGIN
    });
    expect(await screen(ADDRESS)).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('calls TRM and flags OWNERSHIP risk as sanctioned', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(sanctionedPayload));
    const screen = createScreener({
      apiOrigin: API_ORIGIN,
      apiKey: 'test-key'
    });

    expect(await screen(ADDRESS)).toBe(true);
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).equal(`${API_ORIGIN}/screen-addresses`);
    expect(init).include({ method: 'POST' });
    expect(init.headers).deep.equal({
      'content-type': 'application/json',
      'x-api-key': 'test-key'
    });
    const body = JSON.parse(init.body);
    expect(body[0]).deep.equal({
      address: LOWER,
      chain: 'ethereum',
      accountExternalId: null,
      externalId: null
    });
  });

  it.each([
    { name: 'OWNERSHIP risk score is zero', payload: cleanPayload },
    { name: 'only non-OWNERSHIP risk is present', payload: counterpartyExposurePayload }
  ])('returns false when $name', async ({ payload }) => {
    fetchFn.mockResolvedValueOnce(mockResponse(payload));
    const screen = createScreener({
      apiOrigin: API_ORIGIN
    });
    expect(await screen(ADDRESS)).toBe(false);
  });

  it('omits x-api-key header when apiKey is not provided', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(cleanPayload));
    const screen = createScreener({
      apiOrigin: API_ORIGIN
    });
    await screen(ADDRESS);
    const headers = fetchFn.mock.calls[0][1].headers;
    expect(headers).not.toHaveProperty('x-api-key');
  });

  it('defaults apiOrigin to the Polygon TRM gateway when omitted', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(cleanPayload));
    const screen = createScreener({});
    await screen(ADDRESS);
    expect(fetchFn.mock.calls[0][0]).equal(
      'https://api-gateway.polygon.technology/screen-addresses'
    );
  });

  it('caches the result and skips TRM on a second call within TTL', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(sanctionedPayload));
    const screen = createScreener({
      apiOrigin: API_ORIGIN
    });
    expect(await screen(ADDRESS)).toBe(true);
    expect(await screen(ADDRESS)).toBe(true);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('forceRefresh re-queries TRM even with a fresh cache entry', async () => {
    fetchFn
      .mockResolvedValueOnce(mockResponse(cleanPayload))
      .mockResolvedValueOnce(mockResponse(sanctionedPayload));
    const screen = createScreener({
      apiOrigin: API_ORIGIN
    });

    expect(await screen(ADDRESS)).toBe(false);
    expect(await screen(ADDRESS, { forceRefresh: true })).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('treats cache entries older than TTL as stale', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(sanctionedPayload));
    const screen = createScreener({ apiOrigin: API_ORIGIN });

    const stale = {
      [LOWER]: { value: false, timestamp: Date.now() - 91 * 24 * 60 * 60 * 1000 }
    };
    globalThis.localStorage.setItem(CACHE_KEY, JSON.stringify(stale));

    expect(await screen(ADDRESS)).toBe(true);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('returns false on TRM network error (fail-open)', async () => {
    fetchFn.mockRejectedValueOnce(new Error('network'));
    const screen = createScreener({ apiOrigin: API_ORIGIN });
    expect(await screen(ADDRESS)).toBe(false);
  });

  it('returns false on TRM non-2xx status', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse({}, { ok: false }));
    const screen = createScreener({ apiOrigin: API_ORIGIN });
    expect(await screen(ADDRESS)).toBe(false);
  });

  it('prescreen short-circuits to sanctioned when it returns true', async () => {
    const prescreen = vi.fn().mockResolvedValue(true);
    const screen = createScreener({
      apiOrigin: API_ORIGIN,
      prescreen
    });

    expect(await screen(ADDRESS)).toBe(true);
    expect(prescreen).toHaveBeenCalledWith(LOWER);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('prescreen returning false falls through to TRM', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(cleanPayload));
    const prescreen = vi.fn().mockResolvedValue(false);
    const screen = createScreener({
      apiOrigin: API_ORIGIN,
      prescreen
    });

    expect(await screen(ADDRESS)).toBe(false);
    expect(prescreen).toHaveBeenCalledWith(LOWER);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('prescreen throwing falls through to TRM (does not block)', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(sanctionedPayload));
    const prescreen = vi.fn().mockRejectedValue(new Error('firestore unreachable'));
    const screen = createScreener({
      apiOrigin: API_ORIGIN,
      prescreen
    });
    expect(await screen(ADDRESS)).toBe(true);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('lowercases the address for cache keys and TRM payload', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(sanctionedPayload));
    const screen = createScreener({ apiOrigin: API_ORIGIN });
    await screen(ADDRESS);
    const cached = JSON.parse(globalThis.localStorage.getItem(CACHE_KEY) ?? '{}');
    expect(cached).property(LOWER);
    expect(cached).not.property(ADDRESS);
  });

  it('returns the TRM result when cache writes fail', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(sanctionedPayload));
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceeded');
        }
      } satisfies Pick<Storage, 'getItem' | 'setItem'>
    });

    const screen = createScreener({ apiOrigin: API_ORIGIN });
    await expect(screen(ADDRESS)).resolves.toBe(true);
  });

  it('ignores malformed cache entries', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(cleanPayload));
    globalThis.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        [LOWER]: { value: 'bad', timestamp: 'bad' }
      })
    );

    const screen = createScreener({ apiOrigin: API_ORIGIN });
    await expect(screen(ADDRESS)).resolves.toBe(false);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('ignores localStorage.getItem errors', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(cleanPayload));
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error('unavailable');
        },
        setItem: vi.fn()
      } satisfies Pick<Storage, 'getItem' | 'setItem'>
    });

    const screen = createScreener({ apiOrigin: API_ORIGIN });
    await expect(screen(ADDRESS)).resolves.toBe(false);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('returns false when localStorage is unavailable', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(cleanPayload));
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: undefined
    });

    const screen = createScreener({ apiOrigin: API_ORIGIN });
    await expect(screen(ADDRESS)).resolves.toBe(false);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('treats malformed TRM payloads as clean', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse({ nope: true }));
    const screen = createScreener({ apiOrigin: API_ORIGIN });
    await expect(screen(ADDRESS)).resolves.toBe(false);
  });

  it('returns the prescreen result when cache writes fail', async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceeded');
        }
      } satisfies Pick<Storage, 'getItem' | 'setItem'>
    });

    const prescreen = vi.fn().mockResolvedValue(true);
    const screen = createScreener({
      apiOrigin: API_ORIGIN,
      prescreen
    });

    await expect(screen(ADDRESS)).resolves.toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('fails open when fetch is unavailable', async () => {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: undefined
    });

    const screen = createScreener({ apiOrigin: API_ORIGIN });
    await expect(screen(ADDRESS)).resolves.toBe(false);
  });

  it('reports prescreen failure via onScreeningError and falls through to TRM', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(cleanPayload));
    const onScreeningError = vi.fn();
    const prescreen = vi.fn().mockRejectedValue(new Error('firestore unreachable'));
    const screen = createScreener({
      apiOrigin: API_ORIGIN,
      prescreen,
      onScreeningError
    });

    await expect(screen(ADDRESS)).resolves.toBe(false);
    expect(onScreeningError).toHaveBeenCalledOnce();
    expect(onScreeningError).toHaveBeenCalledWith({
      source: 'prescreen',
      address: LOWER,
      error: expect.any(Error)
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('reports TRM rejection via onScreeningError and fails open', async () => {
    fetchFn.mockRejectedValueOnce(new Error('network'));
    const onScreeningError = vi.fn();
    const screen = createScreener({
      apiOrigin: API_ORIGIN,
      onScreeningError
    });

    await expect(screen(ADDRESS)).resolves.toBe(false);
    expect(onScreeningError).toHaveBeenCalledOnce();
    expect(onScreeningError).toHaveBeenCalledWith({
      source: 'trm',
      address: LOWER,
      error: expect.any(Error)
    });
  });

  it('reports TRM non-2xx status via onScreeningError', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse({}, { ok: false }));
    const onScreeningError = vi.fn();
    const screen = createScreener({
      apiOrigin: API_ORIGIN,
      onScreeningError
    });

    await expect(screen(ADDRESS)).resolves.toBe(false);
    expect(onScreeningError).toHaveBeenCalledWith({
      source: 'trm',
      address: LOWER,
      error: expect.any(Error)
    });
  });

  it('logs to console.error when no onScreeningError callback is supplied', async () => {
    fetchFn.mockRejectedValueOnce(new Error('network'));
    const screen = createScreener({ apiOrigin: API_ORIGIN });
    await expect(screen(ADDRESS)).resolves.toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[wallet-kit] Screening failed:',
      expect.any(Error)
    );
  });

  it('does not invoke onScreeningError on cache hits', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(sanctionedPayload));
    const onScreeningError = vi.fn();
    const screen = createScreener({
      apiOrigin: API_ORIGIN,
      onScreeningError
    });

    await screen(ADDRESS);
    await screen(ADDRESS);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(onScreeningError).not.toHaveBeenCalled();
  });
});
