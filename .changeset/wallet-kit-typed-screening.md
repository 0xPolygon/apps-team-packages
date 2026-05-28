---
'@polygonlabs/wallet-kit': major
---

Route screening through the typed `@polygonlabs/api-gateway-client` against the new `GET /api/screening/addresses/{address}` endpoint and return the gateway's `blocked` boolean directly. The previous provider-specific ownership-risk heuristic missed every other risk type — the gateway's threshold-based policy catches them.

## Breaking changes

- `ScreeningConfig.prescreen` is removed. The api-gateway has its own internal `blocklist.json` (Zod-validated at startup, checked before the upstream screening call) that covers what apps were using `prescreen` for. Drop any `prescreen:` field from your `WalletKitProvider` screening config.
- `ScreeningErrorEvent.source` is removed and the `ScreeningErrorSource` type is no longer exported. With `prescreen` gone, the screener has a single failure path (the gateway call) and the discriminator had nothing to distinguish. Drop any `switch (event.source)` / `if (event.source === 'trm')` branches and handle the event unconditionally.
- `ScreeningConfig.apiOrigin` is now host-only (scheme + host, no path) — the typed client prefixes `/api/screening/addresses/{address}`. Most callers already passed host-only, so no change needed unless you were appending a path.

`createScreener`, `Screener`, `OnScreeningError`, and `ScreeningErrorEvent` keep their other exported fields.
