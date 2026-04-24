---
'@polygonlabs/wallet-kit': minor
---

Initial release of `@polygonlabs/wallet-kit`: shared React wallet integration for Polygon Apps Team frontends.

The package owns the wallet plumbing that has drifted between consumer UIs:

- Sequence Connect provider setup
- Sequence v3 transaction-send mode wiring (sets `useWalletTransactionForSend(true)` on connect)
- Connected-wallet state from wagmi exposed through a single `usePolygonWallet` hook
- EIP-7702-aware smart-contract-wallet detection
- TRM sanctions screening with cache, timeout, optional prescreen, and fail-open behaviour
- Wallet classification booleans (`isSequenceWallet`, `isSmartContractWallet`, `requiresApproveInsteadOfPermit`) for SCW UX gating and the permit-flow exception

Consumer apps still own app-specific concerns (chain catalogs, Redux or context shape, modals, analytics, debug mock addresses, transaction flows, route filtering, copy). See the package README for the supported provider and hook surface.
