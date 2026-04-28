import type { Hex } from 'viem';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnectionEffect } from 'wagmi';

import type { CheckOptions, Screener } from '../screening.ts';

interface UseSanctionsScreeningArgs {
  address: Hex | undefined;
  screener: Screener;
  onSanctioned: ((address: Hex) => void) | undefined;
  disconnect: () => void;
}

interface UseSanctionsScreeningResult {
  isWalletSanctioned: boolean;
  refreshScreening: () => Promise<boolean>;
  screenAddress: (address: Hex, options?: CheckOptions) => Promise<boolean>;
}

const toLowerCaseHex = (value: Hex): Hex => value.toLowerCase() as Hex;

export const useSanctionsScreening = ({
  address,
  screener,
  onSanctioned,
  disconnect
}: UseSanctionsScreeningArgs): UseSanctionsScreeningResult => {
  const [sanctionedAddress, setSanctionedAddress] = useState<Hex | null>(null);

  // Tracks whether the in-flight `disconnect()` was triggered by us
  // reacting to a sanctions hit (vs. user-initiated). On the resulting
  // `onDisconnect` we keep `sanctionedAddress` set so the app's
  // sanctions modal stays visible after `address` clears; on a
  // user-initiated disconnect we clear it.
  const sanctionsAutoDisconnectInFlightRef = useRef(false);

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
    onDisconnect() {
      if (sanctionsAutoDisconnectInFlightRef.current) {
        sanctionsAutoDisconnectInFlightRef.current = false;
      } else {
        setSanctionedAddress(null);
      }
    }
  });

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

  const refreshScreening = useCallback(async (): Promise<boolean> => {
    if (!address) return false;
    const sanctioned = await screenAddress(address, { forceRefresh: true });
    applyConnectedScreeningResult(address, sanctioned);
    return sanctioned;
  }, [address, screenAddress, applyConnectedScreeningResult]);

  return {
    isWalletSanctioned: sanctionedAddress !== null,
    refreshScreening,
    screenAddress
  };
};
