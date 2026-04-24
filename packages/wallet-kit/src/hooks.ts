import type { Hex } from 'viem';

import { useCallback, useContext, useEffect, useState } from 'react';

import type { PolygonWallet } from './context.ts';

import { WalletKitContext } from './context.ts';

const SMART_WALLET_DISCLAIMER_STORAGE_KEY_PREFIX =
  'polygon-wallet-kit:smart-wallet-disclaimer-dismissed';

export const usePolygonWallet = (): PolygonWallet => {
  const value = useContext(WalletKitContext);
  if (value === null) {
    throw new Error('usePolygonWallet must be used within a <WalletKitProvider>.');
  }
  return value;
};

export interface UseSmartWalletDisclaimerResult {
  shouldShowDisclaimer: boolean;
  dismiss: () => void;
}

/**
 * Sequence v3 has bytecode but uses EOA-like submission, so only external
 * smart-contract wallets get the disclaimer.
 */
export const useSmartWalletDisclaimer = (): UseSmartWalletDisclaimerResult => {
  const { address, isExternalSmartContractWallet } = usePolygonWallet();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (address === null) {
      setDismissed(false);
      return;
    }
    try {
      setDismissed(globalThis.localStorage.getItem(getDisclaimerStorageKey(address)) === 'true');
    } catch {
      // Storage read failures should behave like a first-time disclaimer view.
      setDismissed(false);
    }
  }, [address]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    if (address === null) return;
    try {
      globalThis.localStorage.setItem(getDisclaimerStorageKey(address), 'true');
    } catch {
      // Persisted dismissal is best-effort; the in-memory state already hides it.
    }
  }, [address]);

  const shouldShowDisclaimer = isExternalSmartContractWallet && !dismissed;

  return { shouldShowDisclaimer, dismiss };
};

const getDisclaimerStorageKey = (address: Hex): string => {
  return `${SMART_WALLET_DISCLAIMER_STORAGE_KEY_PREFIX}:${address.toLowerCase()}`;
};
