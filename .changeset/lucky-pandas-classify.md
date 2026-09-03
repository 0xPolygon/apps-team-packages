---
'@polygonlabs/verror': minor
---

RPC fetch-error sanitisation now keeps the safe, non-credential parts of a failed response, so a caller can tell a rate-limited call from an upstream 5xx or an empty-bodied gateway timeout without capturing the status separately before the error is sanitised.

Previously the sanitised clone reported the HTTP status inconsistently — ethers v6 only as the compound `"429 Too Many Requests"` string, ethers v5 as a bare number under a different key, viem not at all — and dropped the retry-pacing headers entirely, because the objects holding them (ethers' `FetchRequest`/`FetchResponse`, viem's `Headers`) are never copied onto the clone. There was no single field a consumer could classify on.

## What is preserved

The detected RPC node's `info` now carries these flat primitives, normalised across ethers v5, ethers v6 and viem, each present only when the library exposed it:

- `responseStatusCode` — the HTTP status as a number
- `responseStatusMessage` — the HTTP status text
- `responseRetryAfter` — the `retry-after` response header
- `responseRateReset` — the `credits-rate-reset` response header, for providers that pace on credits
- `rpcErrorCode` / `rpcErrorMessage` — the JSON-RPC error the provider returned, parsed from the response body (ethers) or read off the error (viem)

`requestUrl` is now also populated for viem errors, reduced to a bare origin as it already was for ethers, so operators can see which host refused a call.

## What still stays out

Request URLs beyond their origin, request bodies and payloads, request headers, and any response header outside the two-name allowlist. The libraries' request/response objects are still never copied through — only primitives read off them — and every string lifted into `info` is URL-stripped on the way, since `info` is the one part of the clone that downstream code deliberately leaves alone.

## Compatibility

Additive. Existing fields (`requestUrl`, `responseStatus`, `responseBody`) keep their current names, types and values, and every redaction guarantee is unchanged.
