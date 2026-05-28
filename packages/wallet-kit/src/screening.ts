import type { Hex } from 'viem';

import { client, screenAddress } from '@polygonlabs/api-gateway-client';

const DEFAULT_API_ORIGIN = 'https://api-gateway.polygon.technology';

export interface ScreeningErrorEvent {
  address: Hex;
  error: unknown;
}

export interface ScreeningConfig {
  /**
   * Gateway origin. Must be scheme + host with no path — the typed client
   * prefixes `/api/screening/addresses/{address}` itself. Defaults to
   * `https://api-gateway.polygon.technology`.
   */
  apiOrigin?: string;
  apiKey?: string;
  enabled?: boolean;
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
  const headers: Record<string, string> = {};
  if (config.apiKey !== undefined && config.apiKey !== '') {
    headers['x-api-key'] = config.apiKey;
  }
  client.setConfig({
    baseUrl: config.apiOrigin ?? DEFAULT_API_ORIGIN,
    headers
  });

  return async (address) => {
    if (!enabled) return false;
    const normalizedAddress = normalizeAddress(address);

    try {
      const { data, error } = await screenAddress({
        path: { address: normalizedAddress }
      });
      if (error !== undefined || data === undefined) {
        throw error ?? new Error('Screening returned no data');
      }
      return data.blocked;
    } catch (error) {
      onScreeningError({ address: normalizedAddress, error });
      // Fail open so wallet flows do not break on network or service issues.
      return false;
    }
  };
};

const normalizeAddress = (address: Hex): Hex => {
  return address.toLowerCase() as Hex;
};
