---
'@polygonlabs/logger': minor
---

The default pino `err` serializer now sanitises ethers v5 and v6 fetch
errors before emission. `JsonRpcProvider`, `FallbackProvider`,
`StaticJsonRpcProvider`, and anything else built on ethers' web fetch
layer embed the full request URL — including any `?token=<secret>`
query string — in `err.message`, `err.stack`, and (v6)
`err.info.requestUrl` or (v5) top-level `err.url`. Any
`logger.debug({ err })` / `logger.error({ err })` call that previously
received such an error propagated the token into log output; the
sanitiser now intercepts that in the serializer layer, so every
service's log path is protected automatically — HTTP request handlers,
cron ticks, background workers, `unhandledRejection` catches, startup
failures, anywhere.

Detection is structural (duck-typed on the v5/v6 fingerprints), so the
logger does not depend on ethers. The full `.cause` chain is preserved:
a service that wraps an ethers error with
`new VError('fetching block number', { cause: rpcErr })` still sees both
the "what was being attempted" wrapper and the sanitised RPC node in
its logs. URL-stripping runs across every node's `message` and `stack`
as defence in depth; the ethers node's `info` is rebuilt to
`{ requestUrl: origin, responseStatus? }` (drops v5's leaky top-level
`body`/`responseText`/`url`, drops v6's other info fields alongside
`requestUrl`); wrappers' own `info` is preserved unchanged so operators
keep any context the service attached.

Exported as `sanitiseEthersFetchError(err): Error | null` for services
that need to unit-test their own error paths, and for
`@polygonlabs/express`'s global error handler to reuse the sanitised
`.message` for HTTP response bodies (the sanitiser is unaware of which
surface the output is destined for — callers route it).
