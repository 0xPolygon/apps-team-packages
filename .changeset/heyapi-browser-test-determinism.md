---
---

Make the browser-mode test suite deterministic on a warm pnpm store. The Chromium binary is downloaded by `@playwright/browser-chromium`'s install-time postinstall, which pnpm skips on a cache hit (the browser lives in `~/.cache/ms-playwright`, outside the store, so it is neither re-run nor cached) — causing `browserType.launch: Executable doesn't exist` on re-runs. The package's `test` script now re-ensures the browser with an idempotent `playwright install chromium`. Test-only; no consumer-facing change.
