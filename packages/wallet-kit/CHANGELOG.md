# @polygonlabs/wallet-kit

## 1.0.1

### Patch Changes

- f693408: Bump `@0xsequence/connect` devDependency to `^6.0.6` — picks up the upstream fix
  that removes a stray `console.log` from the Sequence v3 connector's `request()`
  method (it was logging every RPC method and params on every request). No API or
  peer dep changes; the peer range remains `^6.0.0`.

## 1.0.0

### Major Changes

- 2f424bc: Initial release of `@polygonlabs/wallet-kit`: shared React wallet integration for Polygon Apps Team frontends.

  The package owns the wallet plumbing that has drifted between consumer UIs:
  - Sequence Connect provider setup
  - Sequence v3 transaction-send mode wiring (sets `useWalletTransactionForSend(true)` on connect)
  - Connected-wallet state from wagmi exposed through a single `usePolygonWallet` hook
  - EIP-7702-aware smart-contract-wallet detection
  - TRM sanctions screening with timeout, optional prescreen, and fail-open behaviour
  - Wallet classification booleans (`isSequenceWallet`, `isSmartContractWallet`, `isExternalSmartContractWallet`, `requiresApproveInsteadOfPermit`) for SCW UX gating and the permit-flow exception
  - `onScreeningError` callback emitting structured `ScreeningErrorEvent`s (`source: 'prescreen' | 'trm'`, normalised address, raw error). Defaults to `console.error` so silent failures are visible without a Sentry hook in place.

  Consumer apps still own app-specific concerns (chain catalogs, Redux or context shape, modals, analytics, debug mock addresses, transaction flows, route filtering, copy). External-SCW disclaimer modals are app-owned: read `isExternalSmartContractWallet` from `usePolygonWallet()` and manage dismissal state in the modal component. Screening cache, if any, is handled behind the configured API/gateway rather than in browser storage. See the package README for the supported provider and hook surface.
