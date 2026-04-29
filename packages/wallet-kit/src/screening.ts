import type { Hex } from 'viem';

const DEFAULT_TIMEOUT_MS = 10_000;

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
}

export type Screener = (address: Hex) => Promise<boolean>;

export type OnScreeningError = (event: ScreeningErrorEvent) => void;

const defaultOnScreeningError: OnScreeningError = (event) => {
  console.error('[wallet-kit] Screening failed:', event.error);
};

export const createScreener = (
  config: ScreeningConfig,
  onScreeningError: OnScreeningError = defaultOnScreeningError
): Screener => {
  const enabled = config.enabled ?? true;

  return async (address) => {
    if (!enabled) return false;
    const normalizedAddress = normalizeAddress(address);

    if (config.prescreen) {
      try {
        const flagged = await config.prescreen(normalizedAddress);
        if (flagged) {
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
      return sanctioned;
    } catch (error) {
      onScreeningError({ source: 'trm', address: normalizedAddress, error });
      // Fail open so wallet flows do not break on network or service issues.
      return false;
    }
  };
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
