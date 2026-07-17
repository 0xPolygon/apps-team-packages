---
'@polygonlabs/resilient-rpc': minor
---

Initial release: multi-endpoint JSON-RPC resilience for chain-facing services.

- Library-agnostic pool (`createRpcPool`) with priority routing, zero-sleep failover on transport failures, and per-endpoint circuit breakers (CLOSED → OPEN → HALF_OPEN) with background `eth_chainId` recovery probes that also verify the chain id.
- Error classification that only lets endpoint-impugning failures affect endpoint health: reverts, bad params and other chain-said errors pass through untouched; rate limiting and endpoint-local data gaps fail over without opening circuits.
- Log-driven degrade signalling via named error classes (`RpcEndpointDegradedError`, `RpcAllEndpointsDownError`, `RpcRequestFailedError`) and a `snapshot()` shaped for `/service-status` exposure.
- `RpcEndpointsSchema` (Zod) parses a single URL, comma-separated list, or JSON array, so single-endpoint configs upgrade to multi-endpoint without code changes.
- Adapters: `resilientTransport` (viem, over viem's own `http` wire) and `ResilientJsonRpcProvider` (ethers v6, statically pinned network).
