# @polygonlabs/resilient-rpc

Multi-endpoint JSON-RPC resilience for chain-facing services: a
library-agnostic pool with per-endpoint circuit breakers, zero-sleep
failover, and a log-driven degrade signal — plus thin adapters for viem and
ethers v6.

## Why not viem `fallback` / ethers `FallbackProvider`?

Both fail over, but neither gives you:

- **A circuit breaker.** A dead endpoint keeps eating a full timeout on
  every rotation. Here it is taken out of rotation after N consecutive
  transport failures and re-admitted only after a background `eth_chainId`
  probe succeeds — and answers with the *right chain id*.
- **A degrade signal.** Failover that works silently hides that you are one
  endpoint away from an outage. The pool logs a named error
  (`RpcEndpointDegradedError`) the moment an endpoint is taken out of
  rotation, so a log monitor can alert while the service is still up.

The pool does not replace your RPC library's wire layer: adapters hand the
core a `rawRequest` closure, so viem requests travel over viem's own `http`
transport and native error objects reach your code untouched.

## Usage

One pool per chain per process — create it at the entrypoint and inject it,
like the logger.

```ts
import { createRpcPool, RpcEndpointsSchema } from '@polygonlabs/resilient-rpc';

const pool = createRpcPool({
  chainId: 137,
  // Priority-ordered: endpoint 0 is preferred, the rest are insurance.
  endpoints: RpcEndpointsSchema.parse(getEnv().POLYGON_RPC),
  logger
});
```

`RpcEndpointsSchema` accepts a single URL, a comma-separated list, or a JSON
array — an existing single-URL env var upgrades to multi-endpoint failover
with a secrets change, no code change.

### viem

```ts
import { createPublicClient } from 'viem';
import { resilientTransport } from '@polygonlabs/resilient-rpc/viem';

const client = createPublicClient({ transport: resilientTransport(pool) });
```

### ethers v6

```ts
import { ResilientJsonRpcProvider } from '@polygonlabs/resilient-rpc/ethers';

const provider = new ResilientJsonRpcProvider(pool);
```

### Health exposure

`pool.snapshot()` returns per-endpoint
`{ origin, state, consecutiveFailures, lastSuccessMs, openSinceMs? }` —
shaped for direct inclusion in a `/service-status` response. Origins only:
full URLs (and the access tokens in their query strings) never appear in
snapshots, logs, or error info.

## Behaviour

- **Routing** — requests go to the highest-priority healthy endpoint. A
  transport-class failure (DNS, connect, reset, timeout, TLS, HTTP 5xx/408,
  malformed JSON-RPC, `-32700`/`-32603`) advances to the next healthy
  endpoint immediately, with zero sleep, and counts against the failing
  endpoint's health. Back-off applies only when re-hitting the same endpoint
  because nothing else is healthy.
- **Circuit breaker** — CLOSED → OPEN after N consecutive transport failures
  (default 3); OPEN endpoints are never selected. A background probe
  (`eth_chainId`, exponential backoff with full jitter, 5s → 60s) moves the
  endpoint through HALF_OPEN back to CLOSED — only if the probe answers with
  the pool's chain id. If every circuit is open, the pool logs
  `RpcAllEndpointsDownError` and rotates through the open endpoints anyway.
- **Error classification** — only endpoint-impugning failures touch health.
  Chain-said errors (reverts, `-32601`/`-32602`, user rejection,
  nonce/funds/underpriced) throw immediately with the native error object
  untouched. Rate limiting (HTTP 429) and endpoint-local data availability
  ("header not found", pruned state) fail over *without* counting toward
  opening. Unknown errors default to pass-through so novel error shapes
  never poison endpoint health.
- **Write safety** — `eth_sendRawTransaction` is failover-safe (idempotent
  by tx hash; "already known" on a retried endpoint means an earlier attempt
  landed — treat it as success). `eth_sendTransaction` never retries or
  fails over: the node assigns the nonce, so a retry could double-send.
- **Exhaustion** — after `maxAttempts` (default `endpoints + 1`) the pool
  throws `RpcRequestFailedError` (a `VError`; `cause` = last native error,
  `info` = `{ chainId, attempts, endpoints }`). The pool logs retried
  attempts at `warn` and never logs the terminal throw — your error boundary
  logs once.

### Observability

Log-driven, with named error classes on the `err` key:

| Event                   | Level   | Signal                                                                                 |
| ----------------------- | ------- | -------------------------------------------------------------------------------------- |
| attempt failed, retried | `warn`  | `{ err, chainId, endpoint, attempt, maxAttempts }`                                      |
| endpoint opened         | `error` | `RpcEndpointDegradedError` with `info: { endpoint, chainId, consecutiveFailures, … }`   |
| re-probe failed         | `error` | `RpcEndpointDegradedError` with `info.downtimeMs`                                       |
| endpoint recovered      | `info`  | `{ chainId, endpoint, downtimeMs }`                                                     |
| all endpoints down      | `error` | `RpcAllEndpointsDownError`                                                              |

The headline alert is `@err.name:RpcEndpointDegradedError` — it fires while
the service is still healthy, which is the point.

## Peer dependencies

`@polygonlabs/logger`, `@polygonlabs/verror`, and `zod` are required peers.
`viem` and `ethers` are optional — install only the one your service uses;
each is required only by its adapter subpath export.
