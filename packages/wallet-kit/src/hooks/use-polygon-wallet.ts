import { useContext } from 'react';

import type { PolygonWallet } from '../context.ts';

import { WalletKitContext } from '../context.ts';

export const usePolygonWallet = (): PolygonWallet => {
  const value = useContext(WalletKitContext);
  if (value === null) {
    throw new Error('usePolygonWallet must be used within a <WalletKitProvider>.');
  }
  return value;
};
