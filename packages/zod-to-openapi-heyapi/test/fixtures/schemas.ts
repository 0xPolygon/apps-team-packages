// Diverse Zod schemas exercising every construct the registry plugin's
// type walker is expected to handle. Each export is registered as a route
// response in fixtures/registry.ts so the plugin emits one transformer +
// one Responses type alias per schema.
//
// Codecs use Zod v4's z.codec() which produces a 'pipe' _def — the walker
// must use the `out` side, not the input wire format.

import { DecimalStringCodec, Int64Codec, IsoDateCodec } from '@polygonlabs/zod-codecs';

import { z } from './zod.ts';

// ── Codecs (the whole point of the plugin) ─────────────────────────────────────
//
// Real codecs live in @polygonlabs/zod-codecs. The fixtures use them here both
// to exercise the published-codec import path the plugin's consumers use and
// to keep the fixture surface honest (no ad-hoc inline defs that drift from
// the shipped behaviour). One inline custom codec is preserved further down
// in `ConstrainedCodec` to cover the "consumer rolls their own" case.

// ── Scalars ────────────────────────────────────────────────────────────────────

export const ScalarString = z.object({
  value: z.string()
});

export const ScalarNumber = z.object({
  value: z.number()
});

export const ScalarBoolean = z.object({
  value: z.boolean()
});

export const ScalarBigInt = z.object({
  value: z.bigint()
});

// ── Optional / nullable ────────────────────────────────────────────────────────

export const OptionalField = z.object({
  required: z.string(),
  optional: z.string().optional()
});

export const NullableField = z.object({
  required: z.string(),
  nullable: z.string().nullable()
});

export const OptionalNullableField = z.object({
  required: z.string(),
  optionalNullable: z.string().nullable().optional()
});

// ── Enums and literals ─────────────────────────────────────────────────────────

export const EnumField = z.object({
  status: z.enum(['pending', 'active', 'archived'])
});

export const LiteralField = z.object({
  type: z.literal('payment')
});

export const UnionOfLiterals = z.object({
  kind: z.union([z.literal('a'), z.literal('b'), z.literal('c')])
});

// ── Arrays ─────────────────────────────────────────────────────────────────────

export const ArrayOfScalars = z.object({
  tags: z.array(z.string())
});

export const ArrayOfCodecs = z.object({
  amounts: z.array(Int64Codec)
});

// ── Records ────────────────────────────────────────────────────────────────────

export const RecordField = z.object({
  metadata: z.record(z.string(), z.string())
});

// ── Nested objects ─────────────────────────────────────────────────────────────

export const Nested = z.object({
  outer: z.object({
    inner: z.object({
      deep: z.string()
    })
  })
});

// ── Unions ─────────────────────────────────────────────────────────────────────

export const UnionField = z.object({
  payload: z.union([z.string(), z.number()])
});

// ── Codecs in fields (the integration target) ──────────────────────────────────

export const CodecObject = z.object({
  id: z.string(),
  amount: Int64Codec,
  currency: z.string(),
  fee: DecimalStringCodec,
  createdAt: z.string()
});

// ── Composed (everything together) ─────────────────────────────────────────────

export const Composed = z.object({
  id: z.string(),
  status: z.enum(['pending', 'completed']),
  amount: Int64Codec,
  metadata: z.record(z.string(), z.string()).optional(),
  tags: z.array(z.string()).optional(),
  parent: z
    .object({
      id: z.string(),
      childAmount: Int64Codec
    })
    .nullable()
    .optional()
});

// ── Pagination wrapper (mirrors a real-world shape) ────────────────────────────

export const PaginatedComposed = z.object({
  hasMore: z.boolean().optional(),
  data: z.array(Composed).optional()
});

// ── Constraints / refinements ──────────────────────────────────────────────────
// .min/.max/.regex/.refine attach checks to a schema. They affect the OpenAPI
// constraints but not the TypeScript output type — the plugin must still emit
// `string`, `number`, etc. without losing fields or collapsing to `unknown`.

export const StringWithMinMax = z.object({
  short: z.string().min(2).max(10),
  long: z.string().min(1)
});

export const NumberWithRange = z.object({
  count: z.number().int().min(0).max(100),
  ratio: z.number().min(0).max(1)
});

export const ArrayWithLength = z.object({
  items: z.array(z.string()).min(1).max(5)
});

export const StringWithFormat = z.object({
  email: z.email(),
  url: z.url(),
  uuid: z.uuid()
});

export const RefinedField = z.object({
  notEmpty: z.string().refine((s) => s.length > 0, { message: 'must not be empty' })
});

export const ConstrainedCodec = z.object({
  // wire: string → runtime: bigint, AND the wire string must look like a digit run
  amount: z.codec(z.string().regex(/^\d+$/), z.bigint(), {
    decode: (s) => BigInt(s),
    encode: (b) => b.toString()
  })
});

// ── Constructs the old hand-rolled walker silently fell through to `unknown` ──
// Each of these is supported by z.infer and now (via z.output<>) supported by
// the plugin emit. Keep this section intact when extending — it's the
// regression suite for "every Zod construct round-trips".

// z.tuple([A, B]) — fixed-length, position-typed
export const TupleField = z.object({
  pair: z.tuple([z.string(), z.number()]),
  pairWithCodec: z.tuple([z.string(), Int64Codec])
});

// z.intersection(A, B) — A & B
export const IntersectionField = z.intersection(
  z.object({ a: z.string() }),
  z.object({ b: z.number() })
);

// z.discriminatedUnion(...) — tagged union
export const DiscriminatedUnion = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('number'), value: z.number() }),
  z.object({ kind: z.literal('amount'), amount: Int64Codec })
]);

// Wire ISO-8601 string ↔ runtime Date — exercises the same `pipe → out`
// path as the int64 codec.
export const DateField = z.object({
  occurredAt: IsoDateCodec
});

// z.set(T) / z.map(K, V) — concrete collection types. Same story: OpenAPI
// doesn't have Set/Map, so we annotate for the spec only.
export const SetField = z.object({
  ids: z.set(z.string()).openapi({ type: 'array', uniqueItems: true, items: { type: 'string' } })
});
export const MapField = z.object({
  byId: z
    .map(z.string(), z.number())
    .openapi({ type: 'object', additionalProperties: { type: 'number' } })
});

// .default(x) — input is optional, output is non-optional
export const DefaultField = z.object({
  // On the wire the field may be missing; parsed value is always a string.
  status: z.string().default('pending')
});

// .readonly() — readonly modifier on the output
export const ReadonlyArrayField = z.object({
  tags: z.array(z.string()).readonly()
});

// z.brand() — branded primitive
const BrandedId = z.string().brand<'UserId'>();
export const BrandedField = z.object({
  userId: BrandedId
});

// ── Error schemas (exercise the Errors / Error emit path) ──────────────────────

export const BadRequestError = z.object({
  code: z.literal('bad_request'),
  message: z.string(),
  fieldErrors: z.record(z.string(), z.string()).optional()
});

export const NotFoundError = z.object({
  code: z.literal('not_found'),
  message: z.string(),
  resourceId: z.string()
});

export const ServerError = z.object({
  code: z.literal('internal_error'),
  message: z.string(),
  // bigint via codec — proves error responses get the same codec-aware typing
  // as success responses.
  traceId: Int64Codec
});

// ── Schemas for multi-status success operations ────────────────────────────────

export const ResourceCreated = z.object({
  id: z.string(),
  createdAt: IsoDateCodec
});

export const ResourceFetched = z.object({
  id: z.string(),
  data: z.string()
});

// ── Input schemas with codecs (request side) ──────────────────────────────────
//
// No `.openapi('Name')` chain — these are raw exports. The plugin
// resolves input slot names via identity lookup against the
// `schemasFrom` module's named exports, so the only thing that matters
// is that the *same instance* held by the export is what the route
// uses in `request.{params, query, body}`. The export name itself
// becomes the import binding emitted in the generated client.
//
// `OpenApiGeneratorV3` inlines per-parameter schemas regardless of
// `.openapi(...)` metadata, so dropping the chain doesn't change the
// spec for these path/query slots. Body schemas without `.openapi(...)`
// also inline rather than `$ref` — fine for the plugin (it only needs
// identity to find the name).
//
// Two codec flavours covered:
//   - `Int64Codec` on a path param — number-flavoured codec, `String(value)`
//     happens to match `z.encode`, so this would round-trip end-to-end
//     even without the plugin's input transformer (kept here as the
//     ergonomic-typing test case).
//   - `IsoDateCodec` on a query param and on a body field — non-trivial
//     `encode` (`d.toISOString()` ≠ locale string). This is the case the
//     input transformer is specifically designed to make work.

// Codec on a path param.
export const BlockNumberPathParams = z.object({
  blockNumber: Int64Codec
});

// Codec on a query param. Also verifies optionality flows through the
// runtime → wire encode (an undefined `since` should not enter the URL).
export const RecentEventsQuery = z.object({
  since: IsoDateCodec.optional()
});

// Codec on a body field — exercises the request-body branch of the input
// transformer. Mixed with non-codec fields to make sure `z.encode` only
// transforms the codec-bearing parts.
export const CreateOrderRequest = z.object({
  reference: z.string().min(1),
  scheduledFor: IsoDateCodec,
  priority: Int64Codec
});

// Path schema for the multi-slot `updateOrder` route. Pairs with
// `UpdateOrderRequest` to exercise an op that has BOTH a path slot
// (the resource id) AND a body slot (the partial update) — the most
// common real-world shape and the one we previously didn't test.
export const OrderIdPathParams = z.object({
  orderId: Int64Codec
});

export const UpdateOrderRequest = z.object({
  scheduledFor: IsoDateCodec.optional(),
  priority: Int64Codec.optional()
});

// Body for the default-optional case: `submitForReview` registers this
// in `request.body.content.*.schema` WITHOUT `required: true`, so
// asteasolutions emits an optional body in the spec and hey-api's
// `${Op}Data.body` is `body?: ...`. We use it to verify that our
// `${Op}Input.body` and the wrapper's `options?:` correctly mirror
// hey-api's "default-optional body" emission.
export const SubmitForReviewRequest = z.object({
  comment: z.string().optional(),
  scheduledFor: IsoDateCodec.optional()
});
