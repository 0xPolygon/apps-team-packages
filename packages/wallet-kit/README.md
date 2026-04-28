# @polygonlabs/wallet-kit

Shared wallet mechanics for Polygon Apps Team React frontends.

The package owns the parts that drift easily across UIs:

- Sequence Connect provider setup
- Sequence v3 transaction-send mode
- connected-wallet state from wagmi
- EIP-7702-aware smart-contract-wallet detection
- TRM sanctions screening with cache, timeout, optional prescreen, and fail-open behavior
- small wallet classification booleans used by SCW UX and permit-flow gating

Apps still own app-specific wrappers: chain catalogs, Redux or app context shape, modals,
analytics, debug mock addresses, transaction flows, route filtering, and copy.

## Install

```bash
pnpm add @polygonlabs/wallet-kit @0xsequence/connect wagmi viem @tanstack/react-query
```

`react` and `react-dom` are peer dependencies. Sequence Connect also has wallet-adapter peers;
install the peers required by the connectors enabled in your Sequence config.

## Provider

```tsx
import { WalletKitProvider } from '@polygonlabs/wallet-kit';

<WalletKitProvider
  sequence={{
    projectAccessKey,
    walletUrl,
    dappOrigin,
    chainIds,
    defaultChainId,
    appName: 'Polygon App',
    signIn: { projectName: 'Polygon App' },
    walletConnect: walletConnectProjectId ? { projectId: walletConnectProjectId } : undefined,
    wagmiConfig: { multiInjectedProviderDiscovery: true }
  }}
  screening={{
    enabled: appEnv === 'production',
    apiKey,
    prescreen: async (address) => isLocallyBlocked(address)
  }}
  onConnect={(event) => trackWalletConnect(event)}
  onSanctioned={(address) => showSanctionModal(address)}
  onProviderError={(error) => Sentry.captureException(error)}
  onScreeningError={(event) => Sentry.captureException(event.error, { tags: { source: event.source } })}
>
  {children}
</WalletKitProvider>;
```

`screening` is opt-in. Pass `false` or omit it to disable sanctions screening.

`onProviderError` fires when wallet-kit fails to resolve the EIP1193 provider from the connected wagmi connector. Connectors that lazily attach `getProvider` (e.g. Safe via WalletConnect during the session handshake) are handled silently — only genuine failures of a present `getProvider` are surfaced. If you omit the callback the kit logs to `console.error` so the failure isn't lost; provide it to route to Sentry/telemetry and suppress the default log.

`onScreeningError` fires when prescreen or TRM screening fails. The screener still falls back to TRM (for prescreen failures) or fails open (for TRM failures) — the callback is purely for observability. The event payload distinguishes the two failure paths via `source: 'prescreen' | 'trm'` and includes the normalised address. If you omit the callback the kit logs to `console.error`; provide it to route to Sentry/telemetry and suppress the default log.

## Hook

```ts
import { usePolygonWallet } from '@polygonlabs/wallet-kit';

const wallet = usePolygonWallet();

wallet.address;
wallet.status;
wallet.chainId;
wallet.walletInfo;
wallet.walletProvider;

wallet.isSequenceWallet;
wallet.isSmartContractWallet;
wallet.isExternalSmartContractWallet;
wallet.requiresApproveInsteadOfPermit;
wallet.isWalletSanctioned;

wallet.connect();
wallet.disconnect();
const switched = await wallet.switchChain(1);
await wallet.screenAddress(destinationAddress);
await wallet.refreshScreening();
```

`screenAddress(address, options)` screens any address with the provider's configured TRM
resolver. It does not disconnect the connected wallet or mutate `isWalletSanctioned`. Results
share the same 90-day localStorage cache as the connected-wallet screen, so screening 50
destination addresses in a session does not produce 50 TRM calls. Pass `{ forceRefresh: true }`
to bypass the cache.

`refreshScreening()` is only for the connected wallet. It force-refreshes screening, sets
`isWalletSanctioned`, calls `onSanctioned`, and disconnects when the connected wallet is
sanctioned.

After a sanctions-triggered disconnect, `isWalletSanctioned` stays `true` so app-owned
modals can remain visible after `address` clears. A later clean connected-wallet screening
result clears it.

`switchChain(chainId)` resolves `true` when the wallet ends up on the requested chain —
already there or switched successfully — and `false` when the switch fails or the user
rejects the prompt. Calling it for the chain the wallet is already on is a no-op.

## Smart Wallet Rules

Use these booleans instead of reimplementing wallet classification in app code:

- `isSmartContractWallet`: connected address has bytecode and is not an EIP-7702 delegation.
- `isSequenceWallet`: connected connector is Sequence v3.
- `isExternalSmartContractWallet`: `isSmartContractWallet && !isSequenceWallet`.
- `requiresApproveInsteadOfPermit`: `isSmartContractWallet || isSequenceWallet`.

The OR in `requiresApproveInsteadOfPermit` is intentional. Sequence v3 returns ERC-1271
signatures for typed data, so ERC20 permit paths should use approve + direct call for both
Sequence v3 and external SCWs.

`detectSmartWallet` treats both `0x` and `undefined` from `getCode` as no deployed code. This
matches viem's normalization of empty RPC bytecode responses.

## Utilities

```ts
import {
  detectSmartWallet,
  isEip7702Delegation,
  isSequenceV3Connector,
  supportsWalletTransactionForSend
} from '@polygonlabs/wallet-kit';
```

`detectSmartWallet({ client, address })` is useful when an app needs to classify an arbitrary
address on an arbitrary chain, such as a custom bridge destination.

## Local Development

For this repo, use the normal commands below.

Published consumers resolve `dist/`. If a sibling app links this package locally and wants to
consume `src/` directly instead of building `dist/` first, opt into the package's source export
condition from that app:

```json
{
  "compilerOptions": {
    "customConditions": ["@polygonlabs/source"]
  }
}
```

Runtime commands in that app also need the matching Node condition:

```bash
node --conditions @polygonlabs/source ...
```

## Commands

```bash
pnpm install
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run build
```

## Release

This repo uses changesets. Runtime/API changes need a changeset:

```bash
pnpm exec changeset add
```

CI/docs/tooling-only changes can use:

```bash
pnpm exec changeset add --empty
```
