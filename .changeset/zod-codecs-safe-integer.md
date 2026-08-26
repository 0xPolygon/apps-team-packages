---
'@polygonlabs/zod-codecs': minor
---

Add `SafeIntegerCodec` — wire integer string ↔ runtime `number`

For string-transported integers that fit a plain JS `number` — query and path parameters (chain ids, page numbers, limits, counts) always arrive as strings, and the runtime wants a `number`. Decoding rejects values outside the safe-integer range, so an oversized digit string fails loudly instead of silently rounding.

This is the sanctioned replacement for `z.coerce.number()` in registry contracts: in zod v4 a coercing schema's input type is `unknown`, so the generated OpenAPI documents the parameter as optional and nullable regardless of intent. The codec declares both the wire and runtime sides honestly. For range-constrained parameters, roll a local codec with a constrained output schema (example in the codec's JSDoc).
