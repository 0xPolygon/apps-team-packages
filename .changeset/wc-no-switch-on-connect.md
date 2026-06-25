---
"@polygonlabs/wallet-kit": patch
---

Fix WalletConnect connections hanging on "Connecting…" for Safe and other smart-contract wallets.

WalletConnect sessions were asked to switch to the application's default network immediately on connect. Safe and other single-chain smart-contract wallets cannot honour a programmatic network switch and never report a chain change back, so the connection stayed stuck on "Connecting…" until a manual page refresh. WalletConnect now connects on the wallet's current network without forcing a switch; users change networks from their wallet, which the application then follows.
