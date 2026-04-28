import type { Hex } from 'viem';

const DEFAULT_CACHE_TTL_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const CACHE_KEY = 'polygon-wallet-kit:wallet-screening';

const DEFAULT_API_ORIGIN = 'https://api-gateway.polygon.technology';

export type ScreeningErrorSource = 'prescreen' | 'trm';

export interface ScreeningErrorEvent {
  source: ScreeningErrorSource;
  address: Hex;
  error: unknown;
}

export interface ScreeningConfig {
  apiOrigin?: string;
  apiKey?: string;
  enabled?: boolean;
  prescreen?: (address: Hex) => Promise<boolean>;
  /**
   * Notified for prescreen and TRM failures. The screener still falls back
   * to TRM (prescreen) or fails open (TRM) — this callback is purely for
   * observability. Defaults to `console.error` so failures aren't swallowed
   * silently when no callback is provided.
   */
  onScreeningError?: (event: ScreeningErrorEvent) => void;
}

export interface CheckOptions {
  forceRefresh?: boolean;
}

export type Screener = (address: Hex, options?: CheckOptions) => Promise<boolean>;

const defaultOnScreeningError = (event: ScreeningErrorEvent): void => {
  console.error('[wallet-kit] Screening failed:', event.error);
};

export const createScreener = (config: ScreeningConfig): Screener => {
  const enabled = config.enabled ?? true;
  const ttlMs = DEFAULT_CACHE_TTL_DAYS * MS_PER_DAY;
  const onScreeningError = config.onScreeningError ?? defaultOnScreeningError;

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
      } catch (error) {
        onScreeningError({ source: 'prescreen', address: normalizedAddress, error });
        // Fall through to TRM — local blocklist failure must not block screening.
      }
    }

    try {
      const sanctioned = await callTrm({
        address: normalizedAddress,
        apiOrigin: config.apiOrigin ?? DEFAULT_API_ORIGIN,
        apiKey: config.apiKey
      });
      writeCache({
        ...cache,
        [normalizedAddress]: { value: sanctioned, timestamp: Date.now() }
      });
      return sanctioned;
    } catch (error) {
      onScreeningError({ source: 'trm', address: normalizedAddress, error });
      // Fail open so wallet flows do not break on network or service issues.
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
      // TRM ownership-risk scoring is address-level for EOAs; `chain` is
      // required by the API but doesn't affect the result we read.
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
