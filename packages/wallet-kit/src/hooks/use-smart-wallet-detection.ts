import type { Hex } from 'viem';

import { useEffect, useState } from 'react';

import type { GetCodeClient } from '../detect-smart-wallet.ts';

import { detectSmartWallet } from '../detect-smart-wallet.ts';

export const useSmartWalletDetection = (
  address: Hex | undefined,
  publicClient: GetCodeClient | undefined
): boolean => {
  const [isSmartContractWallet, setIsSmartContractWallet] = useState(false);

  useEffect(() => {
    setIsSmartContractWallet(false);
    if (!address || !publicClient) {
      return;
    }
    let cancelled = false;
    void detectSmartWallet({ client: publicClient, address })
      .then((result) => {
        if (!cancelled) setIsSmartContractWallet(result);
      })
      .catch(() => {
        if (!cancelled) setIsSmartContractWallet(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address, publicClient]);

  return isSmartContractWallet;
};
