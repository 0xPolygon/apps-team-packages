import type { EIP1193Provider, Hex } from 'viem';

import { createContext } from 'react';

import type { CheckOptions } from './screening.ts';

export interface WalletInfo {
  name: string;
  icon?: string;
}

export interface PolygonWallet {
  address: Hex | null;
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  isConnected: boolean;
  chainId: number | undefined;
  switchChain: (chainId: number) => Promise<boolean>;
  walletInfo: WalletInfo | undefined;
  walletProvider: EIP1193Provider | undefined;
  isSequenceWallet: boolean;
  isSmartContractWallet: boolean;
  isExternalSmartContractWallet: boolean;
  requiresApproveInsteadOfPermit: boolean;
  isWalletSanctioned: boolean;
  connect: () => void;
  disconnect: () => void;
  screenAddress: (address: Hex, options?: CheckOptions) => Promise<boolean>;
  refreshScreening: () => Promise<boolean>;
}

export const WalletKitContext = createContext<PolygonWallet | null>(null);
