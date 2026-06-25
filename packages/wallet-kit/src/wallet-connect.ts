import { walletConnect as wagmiWalletConnect } from 'wagmi/connectors';

import type { Wallet } from '@0xsequence/connect';

import { walletConnect as sequenceWalletConnect } from '@0xsequence/connect';

/**
 * Sequence Connect's built-in WalletConnect connector force-switches the wallet
 * to the config's `defaultChainId` immediately after the session opens (see its
 * `connectors/walletConnect`: it calls `connector.switchChain(defaultNetwork)`
 * whenever the connected chain differs). A Safe — and any single-chain
 * smart-contract wallet — connected over WalletConnect cannot switch chains on
 * command and never emits the `chainChanged` event that wagmi's `switchChain`
 * awaits, so the connect mutation never resolves: the dapp is stuck on
 * "Connecting…" until a manual refresh. The supported path for a Safe is to
 * switch network *in the Safe*, which the app then reacts to.
 *
 * This connector keeps Sequence's WalletConnect descriptor (id, name, logos) so
 * the connect modal is unchanged, but swaps the implementation for wagmi's base
 * WalletConnect connector, which connects on the wallet's current chain and does
 * not switch on connect.
 */
export const nonSwitchingWalletConnect = ({ projectId }: { projectId: string }): Wallet => ({
  ...sequenceWalletConnect({ projectId }),
  createConnector: () => wagmiWalletConnect({ projectId })
});
