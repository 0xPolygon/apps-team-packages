---
'@polygonlabs/verror': minor
'@polygonlabs/logger': minor
---

Closes an RPC-token leak class: `serializeError` and `VError.toJSON` now
auto-sanitise RPC fetch errors before producing their JSON shape, so any
URL embedded in `message`, `stack`, or `info.requestUrl` is reduced to
its origin and `?token=<secret>` query strings never reach the serialised
output. Every persistence path — log lines (already covered via the pino
`err` serializer, unchanged), Firestore documents that store error
snapshots, status routes that ship the JSON directly to clients, Sentry
events — is safe by default. No call-site change required.

The same sanitiser also now covers **viem** alongside ethers v5/v6.
viem's `RpcRequestError` and `HttpRequestError` (fingerprinted on the
class name plus `metaMessages` being an array, a viem `BaseError`-specific
marker) trigger the chain rebuild. Every wrapping viem error
(`ContractFunctionExecutionError`, `EstimateGasExecutionError`, …)
inherits URL stripping via the per-node walk.

## Why this is in `@polygonlabs/verror` now

`sanitiseEthersFetchError` is an Error primitive — peer with `cause`,
`info`, `fullStack` — not a logging concern. It lived in
`@polygonlabs/logger` historically because logger was the first
consumer, but that meant every other persistence path had to remember
to wire it in by hand. The
[l2-spol-rebalancer-mainnet](https://github.com/0xPolygon/lst-api/tree/main/packages/l2-spol-rebalancer)
`/service-status` leak (2026-05-19) happened because the state machine's
`setError` action called `serializeError(err)` on a viem-wrapped
`VError`, reasonably assuming `serializeError` was safe; it wasn't.
Moving the sanitiser down the dep graph and invoking it inside
`serializeError` removes the footgun for every future caller.

## Backward compatibility

- `@polygonlabs/logger` continues to export `sanitiseEthersFetchError`
  (re-exported from `@polygonlabs/verror`), so existing
  `import { sanitiseEthersFetchError } from '@polygonlabs/logger'`
  sites — `@polygonlabs/express`'s `createErrorHandler()`, services
  wiring it manually — keep working without code change.
- Public type signatures unchanged.
- Behaviour change for `serializeError`: a chain containing an RPC
  fetch error now produces sanitised JSON instead of the verbatim
  message text. Any code that was relying on the URL being present in
  serialised output was a leak — this is the fix, not a break.

## Additional fix: `serializeError` preserves more fields on plain Errors

`serializeError`'s plain-Error branch now preserves `info` and
`shortMessage` from the input when present, instead of always emitting
`info: {}` and `shortMessage: message`. Sanitised clones (which are
plain Errors with `info` / `shortMessage` attached during the chain
rebuild) carry both fields through to the serialised output, and any
plain Error that happens to have those attached benefits incidentally.
