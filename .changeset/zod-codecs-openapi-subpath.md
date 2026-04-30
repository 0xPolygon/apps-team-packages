---
'@polygonlabs/zod-codecs': minor
---

Add `@polygonlabs/zod-codecs/openapi` subpath exporting `extendZodAndCodecsWithOpenApi(z)` — a drop-in replacement for `extendZodWithOpenApi` from `@asteasolutions/zod-to-openapi` that also patches `ZodCodec.prototype.openapi`.

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
