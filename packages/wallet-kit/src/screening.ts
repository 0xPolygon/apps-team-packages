import type { Hex } from 'viem';

const DEFAULT_CACHE_TTL_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const CACHE_KEY = 'polygon-wallet-kit:wallet-screening';

export interface ScreeningConfig {
  apiOrigin: string;
  apiKey?: string;
  enabled?: boolean;
  prescreen?: (address: Hex) => Promise<boolean>;
}

export interface CheckOptions {
  forceRefresh?: boolean;
}

export type Screener = (address: Hex, options?: CheckOptions) => Promise<boolean>;

export const createScreener = (config: ScreeningConfig): Screener => {
  const enabled = config.enabled ?? true;
  const ttlMs = DEFAULT_CACHE_TTL_DAYS * MS_PER_DAY;

  return async (address, options) => {
    if (!enabled) return false;
    const normalizedAddress = normalizeAddress(address);

    const cache = readCache();
    const entry = cache[normalizedAddress];
    const forceRefresh = options?.forceRefresh === true;

    if (!forceRefresh && entry !== undefined && isFresh(entry.timestamp, ttlMs)) {
      return entry.value;
    }

    if (config.prescreen) {
      try {
        const flagged = await config.prescreen(normalizedAddress);
        if (flagged) {
          writeCache({
            ...cache,
            [normalizedAddress]: { value: true, timestamp: Date.now() }
          });
          return true;
        }
      } catch {
        // Local blocklist failures should not bypass the TRM fallback.
      }
    }

    try {
      const sanctioned = await callTrm({
        address: normalizedAddress,
        apiOrigin: config.apiOrigin,
        apiKey: config.apiKey
      });
      writeCache({
        ...cache,
        [normalizedAddress]: { value: sanctioned, timestamp: Date.now() }
      });
      return sanctioned;
    } catch {
      // TRM failures are fail-open so wallet flows do not break on network or service issues.
      return false;
    }
  };
};

interface CacheEntry {
  value: boolean;
  timestamp: number;
}

type Cache = Record<string, CacheEntry>;

const readCache = (): Cache => {
  try {
    const raw = globalThis.localStorage.getItem(CACHE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return {};
    return Object.entries(parsed).reduce<Cache>((cache, [address, entry]) => {
      return isCacheEntry(entry) ? { ...cache, [address]: entry } : cache;
    }, {});
  } catch {
    // Corrupt or unreadable cache should behave like a cold cache.
    return {};
  }
};

const writeCache = (cache: Cache): void => {
  try {
    globalThis.localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Cache writes are best-effort; quota/private-mode failures should not block screening.
  }
};

const isFresh = (timestamp: number, ttlMs: number): boolean => Date.now() - timestamp < ttlMs;

const isCacheEntry = (value: unknown): value is CacheEntry => {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<CacheEntry>;
  return typeof candidate.value === 'boolean' && typeof candidate.timestamp === 'number';
};

interface CallTrmArgs {
  address: Hex;
  apiOrigin: string;
  apiKey: string | undefined;
}

const callTrm = async ({ address, apiOrigin, apiKey }: CallTrmArgs): Promise<boolean> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  const headers: Record<string, string> = {
    'content-type': 'application/json'
  };
  if (apiKey !== undefined && apiKey !== '') {
    headers['x-api-key'] = apiKey;
  }

  try {
    const response = await fetch(`${apiOrigin}/screen-addresses`, {
      method: 'POST',
      headers,
      body: JSON.stringify([
        {
          address,
          chain: 'ethereum',
          accountExternalId: null,
          externalId: null
        }
      ]),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`TRM screening failed: ${String(response.status)}`);
    }

    return hasOwnershipRisk(await response.json());
  } finally {
    clearTimeout(timer);
  }
};

const hasOwnershipRisk = (payload: unknown): boolean => {
  return readRiskIndicators(payload).some(isOwnershipRiskIndicator);
};

const readRiskIndicators = (payload: unknown): readonly unknown[] => {
  if (!Array.isArray(payload)) return [];
  const [firstResult] = payload;

  if (!isRecord(firstResult)) return [];

  const indicators = firstResult.addressRiskIndicators;

  return Array.isArray(indicators) ? indicators : [];
};

const isOwnershipRiskIndicator = (value: unknown): boolean => {
  if (!isRecord(value)) return false;

  return value.riskType === 'OWNERSHIP' && Number(value.categoryRiskScoreLevel) > 0;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object';
};

const normalizeAddress = (address: Hex): Hex => {
  return address.toLowerCase() as Hex;
};
