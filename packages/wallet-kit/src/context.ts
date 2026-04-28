import type { EIP1193Provider, Hex } from 'viem';

import { createContext } from 'react';

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
  screenAddress: (address: Hex) => Promise<boolean>;
  screenConnectedWallet: () => Promise<boolean>;
}

export const WalletKitContext = createContext<PolygonWallet | null>(null);
