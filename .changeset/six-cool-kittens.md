---
'@polygonlabs/wallet-kit': patch
---

Bump `@0xsequence/connect` devDependency to `^6.0.6` — picks up the upstream fix
that removes a stray `console.log` from the Sequence v3 connector's `request()`
method (it was logging every RPC method and params on every request). No API or
peer dep changes; the peer range remains `^6.0.0`.
