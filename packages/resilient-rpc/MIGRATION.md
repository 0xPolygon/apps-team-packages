# Migration Guide

## Adopting `@polygonlabs/resilient-rpc`

Initial release — there is no previous version of this package to migrate
from. To adopt it in a service currently using a bare viem `http` transport
or a single-URL ethers `JsonRpcProvider`:

1. Create one pool per chain at the entrypoint (see the README) and inject
   it alongside the logger.
2. Parse the existing RPC URL env var through `RpcEndpointsSchema` — the
   current single-URL value keeps working unchanged; add fallback endpoints
   later via the secret alone.
3. Swap the transport/provider construction for `resilientTransport(pool)`
   (viem) or `new ResilientJsonRpcProvider(pool)` (ethers v6).
4. Expose `pool.snapshot()` on the service's `/service-status` route and
   alert on `@err.name:RpcEndpointDegradedError`.
