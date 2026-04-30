# @polygonlabs/zod-codecs

Zod v4 codecs for the wire formats JSON-on-the-wire services keep reinventing.

JSON has no native `int64`, no unbounded big integer, no precision-preserving
decimal, and no native `Date`. Services serialise these as strings and hope
every consumer decodes them the same way. This package ships the four
decode/encode pairs the team has been writing inline, with the wire-format
validation and runtime-type validation declared together.

## Install

```bash
pnpm add @polygonlabs/zod-codecs zod
```

`zod` is a peer dependency. Requires Zod v4.

## Codecs

| Codec | Wire | Runtime | Use for |
| --- | --- | --- | --- |
| `Int64Codec` | digit-string | `bigint`, int64-bounded | values that exceed `Number.MAX_SAFE_INTEGER` but fit in 64 bits — block heights, monotonic IDs, fixed-width counters |
| `BigIntegerCodec` | digit-string | `bigint`, unbounded | values that can exceed int64 — wei amounts, raw uint256 values |
| `DecimalStringCodec` | decimal-number string | `string` (validated) | financial / on-chain decimals where IEEE-754 precision is unacceptable |
| `IsoDateCodec` | ISO-8601 string | `Date` | datetimes — bare `z.date()` doesn't make sense on the JSON wire |

### Usage

```ts
import { z } from 'zod';
import {
  BigIntegerCodec,
  DecimalStringCodec,
  Int64Codec,
  IsoDateCodec
} from '@polygonlabs/zod-codecs';

const Trade = z.object({
  id: Int64Codec,                    // sequence number — fits in int64
  amountWei: BigIntegerCodec,        // uint256 wei value — needs unbounded bigint
  feeBps: DecimalStringCodec,        // basis points with fractional precision
  executedAt: IsoDateCodec
});

const parsed = await Trade.parseAsync({
  id: '12345',
  amountWei: '12345678901234567890123456789',
  feeBps: '0.0025',
  executedAt: '2025-04-28T13:45:00Z'
});
// parsed.id          → 12345n
// parsed.amountWei   → 12345678901234567890123456789n
// parsed.feeBps      → '0.0025'
// parsed.executedAt  → Date instance
```

`z.encode(schema, value)` runs the encode side and produces the wire shape:

```ts
import { z } from 'zod';

await z.encode(Trade, parsed);
// → {
//     id: '12345',
//     amountWei: '12345678901234567890123456789',
//     feeBps: '0.0025',
//     executedAt: '2025-04-28T13:45:00.000Z'
//   }
```

## OpenAPI metadata

Codecs ship without `.openapi()` metadata baked in. Description,
`x-go-type` hints, and example values are caller-specific — chain them
at the registration site.

In zod v4, `ZodCodec` is a sibling class of `ZodType` rather than a
subclass, so `extendZodWithOpenApi` from
`@asteasolutions/zod-to-openapi` (which patches only
`ZodType.prototype.openapi`) doesn't reach codecs — chaining
`.openapi(...)` on a codec throws `TypeError: not a function`. This
package's `./openapi` entry-point fixes that:

```ts
import { z } from 'zod';
import { extendZodAndCodecsWithOpenApi } from '@polygonlabs/zod-codecs/openapi';
import { Int64Codec } from '@polygonlabs/zod-codecs';

extendZodAndCodecsWithOpenApi(z);

const BlockNumber = Int64Codec.openapi({
  description: 'Block height — fits in int64.',
  'x-go-type': 'int64'
});
```

`extendZodAndCodecsWithOpenApi` is a drop-in replacement for
`extendZodWithOpenApi` — it calls through to the upstream patch and
additionally extends the same patch to `ZodCodec.prototype`, so codec
fields and regular fields behave identically (description, example,
`param: { in, name }` for parameter declarations, refId merging across
chained calls). Idempotent — safe to call multiple times.

`@asteasolutions/zod-to-openapi` is an **optional** peer dependency:
the `./openapi` entry-point is the only thing in this package that
imports it. Codec consumers that don't generate OpenAPI never need it
installed.

## Pairs naturally with `@polygonlabs/zod-to-openapi-heyapi`

`@polygonlabs/zod-to-openapi-heyapi` is the team's `@hey-api/openapi-ts`
plugin that sources Zod schemas (with codecs) from a `zod-to-openapi`
`OpenAPIRegistry`, so generated clients call the codecs at runtime and
hand callers the runtime shapes (`bigint`, `Date`) directly. This codec
package is the recommended companion when using that plugin.

It is not a hard requirement — these codecs work standalone in any
Zod-on-the-wire context: server validation, tRPC, MCP tooling, queue
payloads, anywhere a JSON document crosses a trust boundary.
