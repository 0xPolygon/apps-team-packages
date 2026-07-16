# @polygonlabs/wallet-kit

## 2.0.2

### Patch Changes

- [#73](https://github.com/0xPolygon/apps-team-packages/pull/73) [`006cf08`](https://github.com/0xPolygon/apps-team-packages/commit/006cf081e794bb156cee0f37fabc450c5b03e7c5) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Ship the LICENSE file inside the published npm package

  The previous release added the Apache-2.0 license at the repo root and
  declared it in package.json, but npm only auto-includes a LICENSE file
  in the packed tarball when it lives in the same directory as the
  package's own package.json. The license metadata was correct but the
  actual license text was missing from the published package — this adds
  it.

## 2.0.1

### Patch Changes

- [#71](https://github.com/0xPolygon/apps-team-packages/pull/71) [`aa81b1a`](https://github.com/0xPolygon/apps-team-packages/commit/aa81b1a73e0b4711d195c12e12120f5f67191305) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Add Apache-2.0 license: the package now declares `"license": "Apache-2.0"` in its `package.json`, and the repository carries the full Apache License 2.0 text. Previously no license was declared.

## 2.0.0

### Major Changes

- 77b215c: Route screening through the typed `@polygonlabs/api-gateway-client` against the new `GET /api/screening/addresses/{address}` endpoint and return the gateway's `blocked` boolean directly. The previous provider-specific ownership-risk heuristic missed every other risk type — the gateway's threshold-based policy catches them.

  ## Breaking changes
  - `ScreeningConfig.prescreen` is removed. The api-gateway has its own internal `blocklist.json` (Zod-validated at startup, checked before the upstream screening call) that covers what apps were using `prescreen` for. Drop any `prescreen:` field from your `WalletKitProvider` screening config.
  - `ScreeningErrorEvent.source` is removed and the `ScreeningErrorSource` type is no longer exported. With `prescreen` gone, the screener has a single failure path (the gateway call) and the discriminator had nothing to distinguish. Drop any `switch (event.source)` / `if (event.source === 'trm')` branches and handle the event unconditionally.
  - `ScreeningConfig.apiOrigin` is now host-only (scheme + host, no path) — the typed client prefixes `/api/screening/addresses/{address}`. Most callers already passed host-only, so no change needed unless you were appending a path.

  `createScreener`, `Screener`, `OnScreeningError`, and `ScreeningErrorEvent` keep their other exported fields.

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
