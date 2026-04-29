# Migration Guide

## Adopting `@polygonlabs/wallet-kit`

Use this guide when a frontend already owns its own Sequence Connect setup,
wagmi wallet state, smart-wallet detection, and TRM screening. Move the shared
mechanics into wallet-kit and keep app-specific UI/state in the app.

### Step 1 - Install

```bash
pnpm add @polygonlabs/wallet-kit @0xsequence/connect wagmi viem @tanstack/react-query
```

`react` and `react-dom` are peer dependencies. Sequence Connect may also require
wallet-adapter peers for the connectors enabled by your Sequence config.

### Step 2 - Move Sequence options into a stable config

Wallet-kit creates the live Sequence config internally. Export the options from
module scope, or memoize them, so the provider does not receive a fresh object on
every render.

```ts
import { mainnet, polygon, sepolia } from 'viem/chains';

import type { CreateConfigOptions } from '@0xsequence/connect';

export const sequenceConfigOptions: CreateConfigOptions<'v3'> = {
  projectAccessKey,
  walletUrl,
  dappOrigin,
  chainIds: [mainnet.id, sepolia.id, polygon.id],
  defaultChainId: mainnet.id,
  appName: 'Polygon App',
  signIn: { projectName: 'Polygon App' },
  walletConnect: walletConnectProjectId ? { projectId: walletConnectProjectId } : undefined,
  wagmiConfig: { multiInjectedProviderDiscovery: true }
};
```

### Step 3 - Replace local provider setup

Remove app-local `SequenceConnect`, `createConfig`, `useConnection`,
`useConnectionEffect`, `useDisconnect`, and `useOpenConnectModal` wiring when it
only exists to expose shared wallet state.

```tsx
import { WalletKitProvider } from '@polygonlabs/wallet-kit';

<WalletKitProvider
  sequence={sequenceConfigOptions}
  screening={
    appEnv === 'production'
      ? {
          apiKey: openApiV2ApiKey,
          prescreen: async (address) => isLocallyBlocked(address)
        }
      : false
  }
  onProviderError={(error) => captureException(error)}
>
  {children}
</WalletKitProvider>;
```

Screening is opt-in. Use `false` outside production if internal environments
should bypass TRM.

### Step 4 - Keep only the app-specific adapter

Apps may still keep their existing wallet context as a compatibility adapter.
It should layer only local concerns on top of `usePolygonWallet()`, such as:

- supported app-network selection
- debug or mock-address display helpers
- Sentry user/context tags
- SSR or routing cookies
- app-owned modal state and copy

```tsx
import { WalletKitProvider, usePolygonWallet } from '@polygonlabs/wallet-kit';

function AppWalletAdapter({ children }: { readonly children: ReactNode }) {
  const wallet = usePolygonWallet();
  const appNetwork = isSupportedNetwork(wallet.chainId) ? wallet.chainId : mainnet.id;
  const activeAddress = getMockedAddress() ?? wallet.address ?? '';

  const value = {
    address: wallet.status === 'connected' ? activeAddress : '',
    status: wallet.status,
    chainId: wallet.chainId,
    appNetwork,
    walletInfo: wallet.walletInfo,
    walletProvider: wallet.walletProvider ?? null,
    isSmartContractWallet: wallet.isSmartContractWallet,
    isSequenceWallet: wallet.isSequenceWallet,
    isWalletSanctioned: wallet.isWalletSanctioned,
    connect: wallet.connect,
    disconnect: wallet.disconnect
  };

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
```

Do not screen a mocked/debug address for compliance. `screenConnectedWallet()`
always screens the connected wallet address owned by wallet-kit.

### Step 5 - Replace shared helper calls

Use wallet-kit primitives directly from transaction hooks and UI controls.

```diff
-const { screenWalletAddress, validateAndSwitchNetwork } = useWallet();
+const { appNetwork } = useWallet();
+const { screenConnectedWallet, switchChain } = usePolygonWallet();

-if (await screenWalletAddress(true)) {
+if (await screenConnectedWallet()) {
   return { success: false, error: new Error('Wallet restricted') };
 }

-const isValidNetwork = await validateAndSwitchNetwork();
+const isValidNetwork = await switchChain(appNetwork);
```

For app-network menus:

```diff
-await switchAppNetwork(chainId);
+await switchChain(chainId);
```

For arbitrary destination checks, use `screenAddress(address)`. It does not
disconnect the connected wallet or mutate `isWalletSanctioned`.

### External-SCW disclaimer modals

Wallet-kit does not own external-SCW disclaimer state. Apps that previously
persisted dismissal in localStorage (for example portal or staking-ui) should
keep that modal in the app and drive it from wallet-kit state:

```tsx
const { address, isExternalSmartContractWallet } = usePolygonWallet();
const [dismissed, setDismissed] = useState(false);

useEffect(() => {
  setDismissed(false);
}, [address]);

const showDisclaimer = isExternalSmartContractWallet && !dismissed;
```

With component-local dismissal, the modal re-shows on every fresh connect. If an
app needs cross-session persistence, keep that storage key app-owned rather than
inside wallet-kit.

### Step 6 - Delete local shared copies

Once the adapter and call sites are moved, delete app-local copies of:

- TRM API client, response schemas, and timeout handling
- EIP-7702 bytecode-prefix checks
- generic smart-contract-wallet bytecode detection
- Sequence v3 connector-id checks
- Sequence v3 `setUseWalletTransactionForSend(true)` setup
- duplicated wallet classification booleans

Keep app-owned remote config, modals, transaction flows, analytics, and copy in
the app.

### Behaviour changes to note

- `switchChain(chainId)` resolves `true` when already on the requested chain or
  after a successful switch, and `false` when the wallet switch fails.
- `screenConnectedWallet()` screens the connected wallet. If the wallet is
  sanctioned, wallet-kit sets `isWalletSanctioned`, calls `onSanctioned`, and
  disconnects.
- `screenAddress(address)` screens arbitrary addresses without disconnecting the
  connected wallet.
- Wallet-kit does not write screening results to browser storage. Caching, if
  any, is handled behind the configured API/gateway.
- Sequence v3 wallets are identified separately from generic smart-contract
  wallets. They should not show the external-SCW warning, but should still avoid
  ERC20 permit paths when `requiresApproveInsteadOfPermit` is true.
- TRM failures fail open, matching the existing apps-team frontend behaviour.
  Pass `onScreeningError` on the provider to route prescreen and TRM failures
  to telemetry; the event payload distinguishes sources via `source: 'prescreen' | 'trm'`.

### Verification checklist

- Connect, reconnect, disconnect, and switch chains with every enabled
  connector.
- Confirm Sequence v3 can submit transactions and does not show the generic
  external-SCW warning.
- Confirm external SCWs still show the app-owned SCW warning and timeout UX.
- Confirm sanctioned connected wallets disconnect and keep the app-owned
  sanctions modal visible.
- Confirm transaction flows call `screenConnectedWallet()` before writes that
  require connected-wallet compliance.
- Confirm permit-enabled flows use approve/direct-call paths for SCWs and
  Sequence v3 wallets.
- Confirm any debug mock-address feature changes displayed account data only and
  does not affect compliance screening.
