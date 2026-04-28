# @polygonlabs/zod-codecs

## 1.0.0

### Major Changes

- 1904a32: Initial release of `@polygonlabs/zod-codecs` — four Zod v4 codecs for the wire
  formats JSON-on-the-wire services keep reinventing.

  JSON has no native int64, no unbounded big integer, no precision-preserving
  decimal, and no native `Date`. Services serialise these as strings and every
  consumer has to decode them the same way. This package ships the four
  decode/encode pairs together so the wire validation, the runtime type, and
  the encode round-trip are declared in one place.

  ## Codecs
  - **`Int64Codec`** — wire: signed-integer string; runtime: `bigint` constrained
    to int64 range (`-(2^63)` … `2^63 - 1`). For block heights, monotonic IDs,
    fixed-width counters that exceed `Number.MAX_SAFE_INTEGER` but fit in 64 bits.
  - **`BigIntegerCodec`** — wire: signed-integer string; runtime: unbounded
    `bigint`. For values that can exceed int64 — wei-denominated amounts, raw
    uint256 values from EVM contracts.
  - **`DecimalStringCodec`** — wire: decimal-number string; runtime: same string,
    validated. Defers the choice of decimal library to the consumer; only
    guarantees the shape on the way in.
  - **`IsoDateCodec`** — wire: ISO-8601 string; runtime: `Date`. The realistic
    shape for "wire JSON ↔ runtime `Date`".

  Each codec ships without baked-in `.openapi()` metadata so callers can chain
  `description`, `x-go-type`, and example values at the registration site.

  Pairs naturally with `@polygonlabs/zod-to-openapi-heyapi` for client codegen,
  but works standalone in any Zod-on-the-wire context: server validation, tRPC,
  MCP tooling, queue payloads.
