import type { EIP1193Provider } from 'viem';

import { useEffect, useState } from 'react';

interface ConnectorWithGetProvider {
  getProvider?: () => Promise<unknown>;
}

// Safe via WalletConnect attaches `getProvider` lazily during the session
// handshake. Until wagmi re-emits a connector with `getProvider`,
// `walletProvider` stays `undefined`; if wagmi never re-emits, it stays
// undefined for the connection lifetime. There is no internal retry.
export const resolveConnectorProvider = async (
  connector: ConnectorWithGetProvider | undefined,
  onError?: (error: unknown) => void
): Promise<EIP1193Provider | undefined> => {
  if (!connector || typeof connector.getProvider !== 'function') {
    return undefined;
  }
  try {
    return (await connector.getProvider()) as EIP1193Provider;
  } catch (error) {
    if (onError) {
      onError(error);
    } else {
      console.error('[wallet-kit] Failed to get wallet provider:', error);
    }
    return undefined;
  }
};

export const useResolvedProvider = (
  connector: ConnectorWithGetProvider | undefined,
  onProviderError: ((error: unknown) => void) | undefined
): EIP1193Provider | undefined => {
  const [walletProvider, setWalletProvider] = useState<EIP1193Provider | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void resolveConnectorProvider(connector, onProviderError).then((resolved) => {
      if (!cancelled) setWalletProvider(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [connector, onProviderError]);

  return walletProvider;
};
