import type { QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { EIP1193Provider, Hex } from 'viem';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useConnection,
  useConnectionEffect,
  useDisconnect,
  useSwitchChain,
  usePublicClient
} from 'wagmi';

import type { CreateConfigOptions } from '@0xsequence/connect';

import { SequenceConnect, createConfig, useOpenConnectModal } from '@0xsequence/connect';

import type { PolygonWallet, WalletInfo } from './context.ts';
import type { CheckOptions, ScreeningConfig, Screener } from './screening.ts';

import { WalletKitContext } from './context.ts';
import { detectSmartWallet } from './detect-smart-wallet.ts';
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
  children: ReactNode;
}

export const WalletKitProvider = ({
  sequence,
  queryClient,
  screening,
  onConnect,
  onDisconnect,
  onSanctioned,
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
  children
}: WalletKitInnerProps) => {
  const { address, status, connector, chainId } = useConnection();
  const { mutate: disconnect } = useDisconnect();
  const { mutateAsync: switchChainAsync } = useSwitchChain();
  const { setOpenConnectModal } = useOpenConnectModal();
  const publicClient = usePublicClient({ chainId });

  const [walletProvider, setWalletProvider] = useState<EIP1193Provider | undefined>(undefined);
  const [isSmartContractWallet, setIsSmartContractWallet] = useState(false);
  const [sanctionedAddress, setSanctionedAddress] = useState<Hex | null>(null);
  const sanctionsAutoDisconnectInFlightRef = useRef(false);

  const isSequenceWallet = isSequenceV3Connector(connector);
  const isExternalSmartContractWallet = isSmartContractWallet && !isSequenceWallet;
  const requiresApproveInsteadOfPermit = isSmartContractWallet || isSequenceWallet;
  const isWalletSanctioned = sanctionedAddress !== null;

  const screener = useMemo<Screener>(() => {
    if (!screening) return async () => false;
    return createScreener(screening);
  }, [screening]);

  const applyConnectedScreeningResult = useCallback(
    (checkedAddress: Hex, sanctioned: boolean) => {
      if (!sanctioned) {
        setSanctionedAddress(null);
        return;
      }

      setSanctionedAddress(toLowerCaseHex(checkedAddress));
      onSanctioned?.(checkedAddress);
      sanctionsAutoDisconnectInFlightRef.current = true;
      disconnect();
    },
    [disconnect, onSanctioned]
  );

  const screenAddress = useCallback(
    async (targetAddress: Hex, options?: CheckOptions): Promise<boolean> => {
      return screener(targetAddress, options);
    },
    [screener]
  );

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
      setIsSmartContractWallet(false);
      if (sanctionsAutoDisconnectInFlightRef.current) {
        sanctionsAutoDisconnectInFlightRef.current = false;
      } else {
        setSanctionedAddress(null);
      }
      setWalletProvider(undefined);
      onDisconnect?.();
    }
  });

  useEffect(() => {
    if (!connector) {
      setWalletProvider(undefined);
      return;
    }
    let cancelled = false;
    void connector
      .getProvider()
      .then((resolved) => {
        if (!cancelled) setWalletProvider(resolved as EIP1193Provider);
      })
      .catch(() => {
        if (!cancelled) setWalletProvider(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [connector]);

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

  useEffect(() => {
    if (!address) {
      return;
    }
    const normalizedAddress = toLowerCaseHex(address);
    setSanctionedAddress((current) =>
      current !== null && current !== normalizedAddress ? null : current
    );
    let cancelled = false;
    void screener(address)
      .then((sanctioned) => {
        if (cancelled) return;
        applyConnectedScreeningResult(address, sanctioned);
      })
      .catch(() => {
        if (!cancelled) {
          setSanctionedAddress(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [address, screener, applyConnectedScreeningResult]);

  const switchChain = useCallback(
    async (targetChainId: number): Promise<void> => {
      await switchChainAsync({ chainId: targetChainId });
    },
    [switchChainAsync]
  );

  const connect = useCallback(() => {
    setOpenConnectModal(true);
  }, [setOpenConnectModal]);

  const disconnectAction = useCallback(() => {
    disconnect();
  }, [disconnect]);

  const refreshScreening = useCallback(async (): Promise<boolean> => {
    if (!address) return false;
    const sanctioned = await screenAddress(address, { forceRefresh: true });
    applyConnectedScreeningResult(address, sanctioned);
    return sanctioned;
  }, [address, screenAddress, applyConnectedScreeningResult]);

  const walletInfo = useMemo<WalletInfo | undefined>(
    () =>
      connector
        ? {
            name: connector.name,
            icon: connector.icon
          }
        : undefined,
    [connector]
  );

  const value = useMemo<PolygonWallet>(
    () => ({
      address: address ?? null,
      status,
      isConnected: status === 'connected' && address !== undefined,
      chainId,
      switchChain,
      walletInfo,
      walletProvider,
      isSequenceWallet,
      isSmartContractWallet,
      isExternalSmartContractWallet,
      requiresApproveInsteadOfPermit,
      isWalletSanctioned,
      connect,
      disconnect: disconnectAction,
      screenAddress,
      refreshScreening
    }),
    [
      address,
      status,
      chainId,
      switchChain,
      walletInfo,
      walletProvider,
      isSequenceWallet,
      isSmartContractWallet,
      isExternalSmartContractWallet,
      requiresApproveInsteadOfPermit,
      isWalletSanctioned,
      connect,
      disconnectAction,
      screenAddress,
      refreshScreening
    ]
  );

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

const toLowerCaseHex = (value: Hex): Hex => value.toLowerCase() as Hex;
