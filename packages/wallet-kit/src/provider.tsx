import type { QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Hex } from 'viem';

import { useCallback, useMemo } from 'react';
import {
  useConnection,
  useConnectionEffect,
  useDisconnect,
  usePublicClient,
  useSwitchChain
} from 'wagmi';

import type { CreateConfigOptions } from '@0xsequence/connect';

import { SequenceConnect, createConfig, useOpenConnectModal } from '@0xsequence/connect';

import type { PolygonWallet } from './context.ts';
import type { ScreeningConfig, ScreeningErrorEvent, Screener } from './screening.ts';

import { WalletKitContext } from './context.ts';
import { useResolvedProvider } from './hooks/use-resolved-provider.ts';
import { useSanctionsScreening } from './hooks/use-sanctions-screening.ts';
import { useSmartWalletDetection } from './hooks/use-smart-wallet-detection.ts';
import { createScreener } from './screening.ts';
import { isSequenceV3Connector, supportsWalletTransactionForSend } from './sequence-v3.ts';

export interface WalletConnectEvent {
  address: Hex;
  chainId: number;
  connector: {
    id: string;
    name: string;
    icon?: string;
  };
  isSequenceWallet: boolean;
  isReconnected: boolean;
}

export type ScreeningProp = ScreeningConfig | false;

export interface WalletKitProviderProps {
  sequence: CreateConfigOptions<'v3'>;
  queryClient?: QueryClient;
  screening?: ScreeningProp;
  onConnect?: (event: WalletConnectEvent) => void;
  onDisconnect?: () => void;
  onSanctioned?: (address: Hex) => void;
  /** Routes EIP1193 provider-resolution failures to telemetry. Defaults to `console.error`; provide to suppress. */
  onProviderError?: (error: unknown) => void;
  /** Routes screening (prescreen + TRM) failures to telemetry. Defaults to `console.error`; provide to suppress. */
  onScreeningError?: (event: ScreeningErrorEvent) => void;
  children: ReactNode;
}

export const WalletKitProvider = ({
  sequence,
  queryClient,
  screening,
  onConnect,
  onDisconnect,
  onSanctioned,
  onProviderError,
  onScreeningError,
  children
}: WalletKitProviderProps) => {
  const sequenceConfig = useMemo(() => createConfig(sequence), [sequence]);

  return (
    <SequenceConnect config={sequenceConfig} queryClient={queryClient}>
      <WalletKitInner
        screening={screening}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
        onSanctioned={onSanctioned}
        onProviderError={onProviderError}
        onScreeningError={onScreeningError}
      >
        {children}
      </WalletKitInner>
    </SequenceConnect>
  );
};

interface WalletKitInnerProps {
  screening: ScreeningProp | undefined;
  onConnect: ((event: WalletConnectEvent) => void) | undefined;
  onDisconnect: (() => void) | undefined;
  onSanctioned: ((address: Hex) => void) | undefined;
  onProviderError: ((error: unknown) => void) | undefined;
  onScreeningError: ((event: ScreeningErrorEvent) => void) | undefined;
  children: ReactNode;
}

interface ConnectorWithProvider {
  id: string;
  getProvider: () => Promise<unknown>;
}

const WalletKitInner = ({
  screening,
  onConnect,
  onDisconnect,
  onSanctioned,
  onProviderError,
  onScreeningError,
  children
}: WalletKitInnerProps) => {
  const { address, status, connector, chainId } = useConnection();
  const { mutate: disconnect } = useDisconnect();
  const { mutateAsync: switchChainAsync } = useSwitchChain();
  const { setOpenConnectModal } = useOpenConnectModal();
  const publicClient = usePublicClient({ chainId });

  const screener = useMemo<Screener>(() => {
    if (!screening) return async () => false;
    return createScreener(screening, onScreeningError);
  }, [screening, onScreeningError]);

  const walletProvider = useResolvedProvider(connector, onProviderError);
  const isSmartContractWallet = useSmartWalletDetection(address, publicClient);
  const { isWalletSanctioned, screenAddress, screenConnectedWallet } = useSanctionsScreening({
    address,
    screener,
    onSanctioned,
    disconnect
  });

  const isSequenceWallet = isSequenceV3Connector(connector);
  const isExternalSmartContractWallet = isSmartContractWallet && !isSequenceWallet;
  const requiresApproveInsteadOfPermit = isSmartContractWallet || isSequenceWallet;

  useConnectionEffect({
    onConnect(ctx) {
      void (async () => {
        const sequence = isSequenceV3Connector(ctx.connector);
        if (sequence) {
          await enableWalletTransactionForSend(ctx.connector);
        }
        onConnect?.({
          address: ctx.address,
          chainId: ctx.chainId,
          connector: {
            id: ctx.connector.id,
            name: ctx.connector.name,
            icon: ctx.connector.icon
          },
          isSequenceWallet: sequence,
          isReconnected: ctx.isReconnected
        });
      })();
    },
    onDisconnect() {
      onDisconnect?.();
    }
  });

  const switchChain = useCallback(
    async (targetChainId: number): Promise<boolean> => {
      if (chainId === targetChainId) return true;
      try {
        await switchChainAsync({ chainId: targetChainId });
        return true;
      } catch {
        return false;
      }
    },
    [chainId, switchChainAsync]
  );

  const connect = useCallback(() => {
    setOpenConnectModal(true);
  }, [setOpenConnectModal]);

  const disconnectAction = useCallback(() => {
    disconnect();
  }, [disconnect]);

  const value: PolygonWallet = {
    address: address ?? null,
    status,
    isConnected: status === 'connected' && address !== undefined,
    chainId,
    switchChain,
    walletInfo: connector ? { name: connector.name, icon: connector.icon } : undefined,
    walletProvider,
    isSequenceWallet,
    isSmartContractWallet,
    isExternalSmartContractWallet,
    requiresApproveInsteadOfPermit,
    isWalletSanctioned,
    connect,
    disconnect: disconnectAction,
    screenAddress,
    screenConnectedWallet
  };

  return <WalletKitContext.Provider value={value}>{children}</WalletKitContext.Provider>;
};

export const enableWalletTransactionForSend = async (
  connector: ConnectorWithProvider
): Promise<void> => {
  try {
    const provider = await connector.getProvider();
    if (supportsWalletTransactionForSend(provider)) {
      provider.setUseWalletTransactionForSend(true);
    }
  } catch {
    // Sequence surfaces provider failures through its own connection UI.
  }
};
