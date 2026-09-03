---
'@polygonlabs/verror': minor
---

Sanitised RPC fetch errors now keep the failing library's own field names and structure, with only the secrets scrubbed, so a consumer reads `err.response.statusCode` on an ethers v6 error or `err.status` on a viem one exactly as those libraries document it.

Previously the sanitised error kept the message, stack, `code` and `info` and dropped everything else, which took the HTTP status, the status text and the retry-pacing headers with it. Those live on ethers' `FetchRequest`/`FetchResponse` and viem's `Headers` — class instances whose fields are private, so they survive neither a spread nor `JSON.stringify` as anything but `{}`. Each is now projected onto the sanitised error as a plain object under the same key with the same sub-keys:

- **ethers v6** — `response` as `{ statusCode, statusMessage, headers }` and `request` as `{ url, method }`, alongside the existing `code` and `info`
- **ethers v5** — its own `status`, `reason`, `requestMethod`, `headers` and `url`
- **viem** — `status`, `code` (the numeric JSON-RPC code), `details`, `metaMessages` and `url`

`serializeError` and `VError.toJSON` carry those fields onto the serialised record instead of copying a fixed key set, so the shape reaches logs, persisted state and status routes intact.

## Redaction

Only what is known to be dangerous is removed; everything else is left as the library had it.

Every URL is reduced to a bare origin — not merely query-stripped, since some providers put the key in the path — including inside `metaMessages`. Request headers and request bodies are never copied: a request header set is small and credential-bearing by design, so the whole set goes. Response headers are the opposite — mostly debug metadata — so they are kept except for the names known to carry a credential (`authorization`, `cookie`, `set-cookie`, `www-authenticate` and relatives, plus any name containing `token`, `secret`, `api-key`, `password` or `credential`). `x-request-id`, `server`, `cf-ray` and `x-envoy-upstream-service-time` therefore survive for diagnosis. The field spread applies only to errors that went through sanitisation, never to an unrecognised error whose own fields have been through no projection.

## Nested ethers v5 errors are now reached

ethers v5 nests an inner error under `.error`, not `.cause`. A contract revert surfaces as a `CALL_EXCEPTION` whose `.error` is the fetch failure carrying the credentialed URL, and the chain walk only followed `.cause` — so that node was unreachable, nothing was stripped, and the outer error's message (which v5 composes by stringifying every parameter, the nested error included) published the token. The walk now falls back to `.error`. This does not widen what counts as an RPC fetch error: detection still requires a genuine fingerprint on some node.

## Wider viem coverage

The viem fingerprint now covers every `BaseError` subclass that carries a URL — `TimeoutError`, `SocketClosedError` and `WebSocketRequestError` alongside `HttpRequestError` and `RpcRequestError`. Those three were previously not detected at all, and viem's own URL helper strips basic-auth credentials but not a token in the query or path, so a timed-out or dropped connection could publish one. This closes that.

## Compatibility

Additive. Every field that was already emitted keeps its name, type and value, and no redaction guarantee is relaxed.
