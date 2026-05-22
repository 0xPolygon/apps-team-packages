---
'@polygonlabs/verror': patch
---

Bugfix: HTTPError is now W-by-default. The cause's message is no longer
appended to an HTTPError's own `.message` — matching what the team
standard has always documented ("Use WError at REST API boundaries").
HTTP errors exist for the API boundary; leaking a downstream cause's
text into `.message` was the bug. Three coordinated changes inside
`@polygonlabs/verror`, all behind the same `WERROR_SYMBOL` marker that
already identifies `WError`:

- `HTTPError.prototype[WERROR_SYMBOL] = true` (set in a static block on
  the class). `VError`'s constructor reads it via
  `new.target.prototype` during `super()`, so every subclass
  (`BadRequest`, `NotAuthenticated`, `NotFound`, `GeneralError`, …)
  inherits the W behaviour without per-class wiring.
- `VErrorOptions.skipCauseMessage` removed (it was marked `@internal`
  and only set by `WError`'s constructor). The decision now lives on
  the prototype where it belongs — no hidden runtime flag, no
  two-sources-of-truth for "is this a boundary wrapper?"
- `WError.toString()` override deleted. It was explicitly re-appending
  the cause's message via `; caused by ${cause.toString()}`, defeating
  the boundary semantic that `.message` was respecting. `String(wErr)`,
  template literals, log-formatter fallbacks — anywhere a WError gets
  stringified — now surface only the boundary author's own message.
  The cause stays reachable via `err.cause` / `VError.cause(err)`.

Adopting this is a patch: every public API stays the same, and
`.message` on HTTPErrors that were thrown without a cause is unchanged.
The only behaviour difference is HTTPErrors thrown with `{ cause }` —
previously the cause's text leaked into `.message` (the bug); now it
does not. Code relying on the leaked text was relying on a contract
the team standard explicitly told it not to use.
