# @polygonlabs/zod-codecs

## 1.2.0

### Minor Changes

- [#81](https://github.com/0xPolygon/apps-team-packages/pull/81) [`d46e7d4`](https://github.com/0xPolygon/apps-team-packages/commit/d46e7d42604c89883a60b4dfb1b1fc769077940e) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Add `SafeIntegerCodec` — wire integer string ↔ runtime `number`

  For string-transported integers that fit a plain JS `number` — query and path parameters (chain ids, page numbers, limits, counts) always arrive as strings, and the runtime wants a `number`. Decoding rejects values outside the safe-integer range, so an oversized digit string fails loudly instead of silently rounding.

  This is the sanctioned replacement for `z.coerce.number()` in registry contracts: in zod v4 a coercing schema's input type is `unknown`, so the generated OpenAPI documents the parameter as optional and nullable regardless of intent. The codec declares both the wire and runtime sides honestly. For range-constrained parameters, roll a local codec with a constrained output schema (example in the codec's JSDoc).

## 1.1.2

### Patch Changes

- [#73](https://github.com/0xPolygon/apps-team-packages/pull/73) [`006cf08`](https://github.com/0xPolygon/apps-team-packages/commit/006cf081e794bb156cee0f37fabc450c5b03e7c5) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Ship the LICENSE file inside the published npm package

  The previous release added the Apache-2.0 license at the repo root and
  declared it in package.json, but npm only auto-includes a LICENSE file
  in the packed tarball when it lives in the same directory as the
  package's own package.json. The license metadata was correct but the
  actual license text was missing from the published package — this adds
  it.

## 1.1.1

### Patch Changes

- [#71](https://github.com/0xPolygon/apps-team-packages/pull/71) [`aa81b1a`](https://github.com/0xPolygon/apps-team-packages/commit/aa81b1a73e0b4711d195c12e12120f5f67191305) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Add Apache-2.0 license: the package now declares `"license": "Apache-2.0"` in its `package.json`, and the repository carries the full Apache License 2.0 text. Previously no license was declared.

## 1.1.0

### Minor Changes

- 6c3456b: Add `@polygonlabs/zod-codecs/openapi` subpath exporting `extendZodAndCodecsWithOpenApi(z)` — a drop-in replacement for `extendZodWithOpenApi` from `@asteasolutions/zod-to-openapi` that also patches `ZodCodec.prototype.openapi`.

  In zod v4, `ZodCodec` is a sibling class of `ZodType` rather than a subclass. `extendZodWithOpenApi` only patches `ZodType.prototype.openapi`, so the patch never lands on codecs — chaining `.openapi(...)` on `Int64Codec` / `BigIntegerCodec` / `IsoDateCodec` / `DecimalStringCodec` throws `TypeError: not a function` at runtime, which made the README's own `.openapi()` example impossible to actually use.

  `extendZodAndCodecsWithOpenApi(z)` calls through to the upstream patch and copies (not delegates to) the resulting `ZodType.prototype.openapi` function onto `ZodCodec.prototype`. The function body only references `this.constructor` and `this._def`, both of which codecs have, so codecs get full-fidelity `.openapi(...)` semantics: fresh-instance creation per call, `param: { in, name }` handling for parameter declarations, `refId` and metadata merge with prior calls — identical to what regular schemas already get. The OpenAPI document produced by `OpenApiGeneratorV3` reads the same registry the asteasolutions patch writes to, so codec fields and regular fields are indistinguishable in the output.

  ```ts
  import { z } from 'zod';
  import { extendZodAndCodecsWithOpenApi } from '@polygonlabs/zod-codecs/openapi';
  import { BigIntegerCodec } from '@polygonlabs/zod-codecs';

  extendZodAndCodecsWithOpenApi(z);

  const Wei = BigIntegerCodec.openapi({
    description: 'Amount in wei — decoded to bigint by the client.',
    example: '1000000000000000000'
  });
  ```

  `@asteasolutions/zod-to-openapi` is now an **optional** peer dependency (`peerDependenciesMeta.@asteasolutions/zod-to-openapi.optional: true`); the `./openapi` entry-point is the only thing in this package that imports it. Codec consumers that don't generate OpenAPI never need it installed. Existing consumers that already had it as a direct dep see no change.

  The README has been updated to use `extendZodAndCodecsWithOpenApi` in the OpenAPI metadata section. The previous example, which used `extendZodWithOpenApi` directly, would have failed at runtime when chained on a codec.

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
