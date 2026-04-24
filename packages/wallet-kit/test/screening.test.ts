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

const sanctionedPayload = [
  {
    addressRiskIndicators: [{ riskType: 'OWNERSHIP', categoryRiskScoreLevel: 10 }]
  }
];

const cleanPayload = [
  {
    addressRiskIndicators: [{ riskType: 'COUNTERPARTY_EXPOSURE', categoryRiskScoreLevel: 5 }]
  }
];

describe('createScreener', () => {
  let fetchFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: memoryStorage()
    });
  });

  afterEach(() => {
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
    expect(url).to.equal(`${API_ORIGIN}/screen-addresses`);
    expect(init).to.include({ method: 'POST' });
    expect(init.headers).to.deep.equal({
      'content-type': 'application/json',
      'x-api-key': 'test-key'
    });
    const body = JSON.parse(init.body);
    expect(body[0]).to.deep.equal({
      address: LOWER,
      chain: 'ethereum',
      accountExternalId: null,
      externalId: null
    });
  });

  it('returns false when OWNERSHIP risk is absent', async () => {
    fetchFn.mockResolvedValueOnce(mockResponse(cleanPayload));
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
    expect(prescreen).toHaveBeenCalledOnce();
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
    expect(cached).to.have.property(LOWER);
    expect(cached).not.to.have.property(ADDRESS);
  });

  it('swallows localStorage.setItem errors', async () => {
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

  it('fails open when prescreen storage write throws', async () => {
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

  it('passes the normalized address to prescreen', async () => {
    const prescreen = vi.fn().mockResolvedValue(false);
    fetchFn.mockResolvedValueOnce(mockResponse(cleanPayload));
    const screen = createScreener({
      apiOrigin: API_ORIGIN,
      prescreen
    });

    await screen(ADDRESS);
    expect(prescreen).toHaveBeenCalledWith(LOWER);
  });

  it('fails open when fetch is unavailable', async () => {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: undefined
    });

    const screen = createScreener({ apiOrigin: API_ORIGIN });
    await expect(screen(ADDRESS)).resolves.toBe(false);
  });
});
