// Asserts on the textual output of registry-validator.gen.ts to verify the
// plugin emits the right shape for each fixture operation. Per-field type
// correctness (e.g. that an int64 codec yields bigint) is checked in
// types.test.ts via `Equal<Generated, z.output<typeof Schema>>` — these
// assertions cover the file-level invariants the type tests can't see:
// imports, transformer presence, `data: unknown` annotation, etc.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { generatedDir } from './setup.ts';

const generatedFile = resolve(generatedDir, 'registry-validator.gen.ts');

function readGenerated(): string {
  return readFileSync(generatedFile, 'utf8');
}

// Operations with at least one 2xx response — the only ones that produce a
// transformer. `getErrorsOnly` (errors-only) is intentionally absent.
const OPERATIONS_WITH_TRANSFORMER = [
  'getScalarString',
  'getScalarNumber',
  'getScalarBoolean',
  'getScalarBigInt',
  'getOptionalField',
  'getNullableField',
  'getOptionalNullableField',
  'getEnumField',
  'getLiteralField',
  'getUnionOfLiterals',
  'getArrayOfScalars',
  'getArrayOfCodecs',
  'getRecordField',
  'getNested',
  'getUnionField',
  'getCodecObject',
  'getComposed',
  'getPaginatedComposed',
  'getStringWithMinMax',
  'getNumberWithRange',
  'getArrayWithLength',
  'getStringWithFormat',
  'getRefinedField',
  'getConstrainedCodec',
  'getTupleField',
  'getIntersectionField',
  'getDiscriminatedUnion',
  'getDateField',
  'getSetField',
  'getMapField',
  'getDefaultField',
  'getReadonlyArrayField',
  'getBrandedField',
  'createOrFetchResource'
];

describe('registry plugin emit', () => {
  it('emits a transformer for every operation that has a 2xx response', () => {
    const src = readGenerated();
    for (const op of OPERATIONS_WITH_TRANSFORMER) {
      expect(src, `transformer for ${op}`).toMatch(
        new RegExp(`export const ${op}Transformer = async`)
      );
    }
  });

  it('imports schemas from the configured schemasFrom path', () => {
    const src = readGenerated();
    expect(src).toMatch(/from '#test-fixtures\/schemas'/);
  });

  it("imports z from 'zod' so the type aliases can reference z.output", () => {
    const src = readGenerated();
    expect(src).toMatch(/import \{ z \} from 'zod'/);
  });

  it('annotates the transformer data parameter as unknown', () => {
    const src = readGenerated();
    const matches = src.match(/async \(data\b[^)]*\)/g) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(m).toMatch(/data: unknown/);
    }
  });

  it('emits both XResponse and XResponses aliases per 2xx-bearing operation', () => {
    const src = readGenerated();
    for (const op of OPERATIONS_WITH_TRANSFORMER) {
      const cap = op.charAt(0).toUpperCase() + op.slice(1);
      expect(src, `${cap}Response alias`).toMatch(new RegExp(`export type ${cap}Response = `));
      expect(src, `${cap}Responses alias`).toMatch(new RegExp(`export type ${cap}Responses = `));
    }
  });

  it('aliases each XResponse to XResponses[keyof XResponses]', () => {
    // The singular `Response` is now an indexed-union over the keyed Responses
    // shape — matching hey-api's standard typescript plugin convention.
    const src = readGenerated();
    expect(src).toMatch(
      /export type GetCodecObjectResponse = GetCodecObjectResponses\[keyof GetCodecObjectResponses\];/
    );
    expect(src).toMatch(
      /export type GetComposedResponse = GetComposedResponses\[keyof GetComposedResponses\];/
    );
    expect(src).toMatch(
      /export type GetScalarStringResponse = GetScalarStringResponses\[keyof GetScalarStringResponses\];/
    );
  });

  it('keys the Responses object by status code → z.output<typeof Schema>', () => {
    const src = readGenerated();
    // The 200 key isn't quoted by hey-api's emitter.
    expect(src).toMatch(
      /export type GetCodecObjectResponses = \{\s*200: z\.output<typeof CodecObject>;\s*\};/
    );
  });

  it('binds each transformer to the right schema via parseAsync', () => {
    const src = readGenerated();
    expect(src).toMatch(
      /export const getCodecObjectTransformer = async \(data: unknown\): Promise<z\.output<typeof CodecObject>> => await CodecObject\.parseAsync\(data\);/
    );
    expect(src).toMatch(
      /export const getComposedTransformer = async \(data: unknown\): Promise<z\.output<typeof Composed>> => await Composed\.parseAsync\(data\);/
    );
  });

  it('uses Promise<z.output<typeof Schema>> as the transformer return type', () => {
    // Match every transformer signature line. The Promise<...> wraps a
    // generic that itself contains a `>`, so the regex matches `>>` to capture
    // both layers of brackets.
    const src = readGenerated();
    const sigs = src.match(/async \(data: unknown\): Promise<z\.output<typeof \w+>>/g) ?? [];
    expect(sigs.length).toBeGreaterThan(0);
    expect(src).not.toMatch(/Promise<unknown>/);
  });

  // ── Multi-status emission ────────────────────────────────────────────────────

  it('keys Responses by every 2xx status code, not just 200', () => {
    const src = readGenerated();
    // createOrFetchResource defines 200 (ResourceFetched) + 201 (ResourceCreated).
    expect(src).toMatch(
      /export type CreateOrFetchResourceResponses = \{\s*200: z\.output<typeof ResourceFetched>;\s*201: z\.output<typeof ResourceCreated>;\s*\};/
    );
  });

  it('aliases the singular Response as Responses[keyof Responses]', () => {
    const src = readGenerated();
    expect(src).toMatch(
      /export type CreateOrFetchResourceResponse = CreateOrFetchResourceResponses\[keyof CreateOrFetchResourceResponses\];/
    );
  });

  it('emits Errors keyed by 4xx/5xx status codes when error schemas are registered', () => {
    const src = readGenerated();
    // 400 BadRequestError, 404 NotFoundError, 500 ServerError — all distinct
    // schemas. Order in the source matches spec order.
    expect(src).toMatch(
      /export type CreateOrFetchResourceErrors = \{\s*400: z\.output<typeof BadRequestError>;\s*404: z\.output<typeof NotFoundError>;\s*500: z\.output<typeof ServerError>;\s*\};/
    );
  });

  it('aliases the singular Error as Errors[keyof Errors]', () => {
    const src = readGenerated();
    expect(src).toMatch(
      /export type CreateOrFetchResourceError = CreateOrFetchResourceErrors\[keyof CreateOrFetchResourceErrors\];/
    );
  });

  it('emits Errors but no transformer for an operation with only error responses', () => {
    const src = readGenerated();
    expect(src).toMatch(/export type GetErrorsOnlyErrors = \{/);
    expect(src).toMatch(/export type GetErrorsOnlyError = GetErrorsOnlyErrors\[keyof /);
    // No 2xx → no Responses, no transformer.
    expect(src).not.toMatch(/export type GetErrorsOnlyResponses\b/);
    expect(src).not.toMatch(/export const getErrorsOnlyTransformer\b/);
  });

  it('emits a z.union transformer when multiple 2xx schemas exist', () => {
    // createOrFetchResource has 200 (ResourceFetched) + 201 (ResourceCreated).
    // The transformer must accept both — client-fetch invokes it for any 2xx
    // status without dispatching, so binding to a single schema would throw
    // at runtime when the other status fires. Both runtime parser and static
    // return type span the union.
    const src = readGenerated();
    expect(src).toMatch(
      /export const createOrFetchResourceTransformer = async \(data: unknown\): Promise<z\.output<typeof ResourceFetched> \| z\.output<typeof ResourceCreated>> => await z\.union\(\[ResourceFetched, ResourceCreated\]\)\.parseAsync\(data\);/
    );
  });

  it('keeps the simple form for a single-schema 2xx', () => {
    // The single-schema case must not be wrapped in z.union — that would be
    // unnecessary runtime overhead and obscure the emitted code.
    const src = readGenerated();
    expect(src).toMatch(
      /export const getCodecObjectTransformer = async \(data: unknown\): Promise<z\.output<typeof CodecObject>> => await CodecObject\.parseAsync\(data\);/
    );
    expect(src).not.toMatch(/getCodecObjectTransformer.*z\.union/);
  });

  it('does not import or emit anything for parameter-only schemas', () => {
    // The fixture registry registers `itemId` as a path parameter (lower-case
    // by design). zod-to-openapi v8 lifts the parameter's schema into both
    // `components.parameters.itemId` and `components.schemas.itemId` — the
    // latter would have tripped the original audit, which walked the entire
    // `components.schemas` map and demanded a Zod export under every name.
    //
    // The corrected audit walks only response `$ref`s, so a registered
    // parameter (with no Zod export under that name) must not produce any
    // emit in the generated client.
    const src = readGenerated();
    expect(src).not.toMatch(/import \{[^}]*\bitemId\b[^}]*\}/);
    expect(src).not.toMatch(/typeof itemId\b/);
    expect(src).not.toMatch(/\bitemId\.parseAsync/);
  });

  it('still emits the response-side transformer for an operation with a registered parameter', () => {
    // `getItemWithRegisteredParam` returns ScalarString. The audit narrowing
    // must not regress the emit for the response side — only filter the
    // parameter out of the audit set.
    const src = readGenerated();
    expect(src).toMatch(
      /export const getItemWithRegisteredParamTransformer = async \(data: unknown\): Promise<z\.output<typeof ScalarString>> => await ScalarString\.parseAsync\(data\);/
    );
  });

  // ── Input-side codec encoding ──────────────────────────────────────────────

  it('emits an Input type for ops with a registered path schema', () => {
    // `lookupBlock` declares `params: BlockNumberPathParams` (registered with
    // refId 'BlockNumberPathParams'). The Input type overrides `path` with
    // the runtime shape via `z.output<typeof BlockNumberPathParams>`, so a
    // caller can pass `{ blockNumber: bigint }` instead of the wire string.
    const src = readGenerated();
    expect(src).toMatch(
      /export type LookupBlockInput = Omit<LookupBlockData, 'path'> & \{\s*path: z\.output<typeof BlockNumberPathParams>;\s*\};/
    );
  });

  it('emits an input transformer that runs z.encode on the path slot, guarded against undefined', () => {
    // Conditional spread handles optional slots — the same emission shape
    // is used for required slots too (it's a runtime no-op but keeps the
    // emission uniform).
    const src = readGenerated();
    expect(src).toMatch(
      /export const lookupBlockInputTransformer = async \(input: Pick<LookupBlockInput, 'path'>\) => \(\{ \.\.\.input\.path !== undefined \? \{ path: await z\.encode\(BlockNumberPathParams, input\.path\) \} : \{\} \}\);/
    );
  });

  it('emits a same-name SDK wrapper that calls the input transformer before delegating', () => {
    // The wrapper has the SAME name as the SDK function. With
    // `includeInEntry: false` set on `@hey-api/sdk`, the auto-barrel only
    // re-exports our wrapper — and hey-api auto-aliases the SDK plugin's
    // emission inside this file (`lookupBlock2`) to avoid a local collision.
    // The merged options is cast to the SDK's wire-shaped Options<${Op}Data>
    // because the structural type is the union of runtime + wire (the second
    // spread overrides the first at runtime).
    const src = readGenerated();
    expect(src).toMatch(
      /import \{[^}]*\blookupBlock as lookupBlock2\b[^}]*\} from '\.\/sdk\.gen\.ts'/
    );
    expect(src).toMatch(
      /export const lookupBlock = async <ThrowOnError extends boolean = false>\(options: Options<LookupBlockInput, ThrowOnError>\) => \{\s*const transformed = await lookupBlockInputTransformer\(options\);\s*return await lookupBlock2\(\{ \.\.\.options, \.\.\.transformed \} as Options<LookupBlockData, ThrowOnError>\);\s*\};/
    );
  });

  it('preserves slot optionality from the SDK Data type', () => {
    // `listRecentEvents` uses `query: RecentEventsQuery` with
    // `IsoDateCodec.optional()`. No query param is required, so hey-api
    // emits `query?: ...` in `${Op}Data` and we mirror that — caller can
    // omit the slot entirely.
    const src = readGenerated();
    expect(src).toMatch(
      /export type ListRecentEventsInput = Omit<ListRecentEventsData, 'query'> & \{\s*query\?: z\.output<typeof RecentEventsQuery>;\s*\};/
    );
    expect(src).toMatch(
      /export const listRecentEventsInputTransformer = async \(input: Pick<ListRecentEventsInput, 'query'>\) => \(\{ \.\.\.input\.query !== undefined \? \{ query: await z\.encode\(RecentEventsQuery, input\.query\) \} : \{\} \}\);/
    );
  });

  it('emits required slot when the SDK Data declares it required (body with required: true)', () => {
    // `createOrder`'s route config sets `body: { required: true, ... }`,
    // so `${Op}Data.body` is required and our override mirrors that.
    const src = readGenerated();
    expect(src).toMatch(
      /export type CreateOrderInput = Omit<CreateOrderData, 'body'> & \{\s*body: z\.output<typeof CreateOrderRequest>;\s*\};/
    );
    expect(src).toMatch(
      /export const createOrderInputTransformer = async \(input: Pick<CreateOrderInput, 'body'>\) => \(\{ \.\.\.input\.body !== undefined \? \{ body: await z\.encode\(CreateOrderRequest, input\.body\) \} : \{\} \}\);/
    );
  });

  it('does not emit Input artifacts for ops without a registered input schema', () => {
    // `getItemWithRegisteredParam` declares `params: z.object({ itemId: ... })`
    // — anonymous wrapping object with no refId. The plugin must not emit
    // any Input type / transformer / wrapper for it; consumers continue to
    // call the raw SDK function for those ops.
    const src = readGenerated();
    expect(src).not.toMatch(/export type GetItemWithRegisteredParamInput\b/);
    expect(src).not.toMatch(/getItemWithRegisteredParamInputTransformer/);
    // The op's response transformer is still emitted (covered above).
  });

  it('imports the Options type and per-op SDK function from sdk.gen', () => {
    const src = readGenerated();
    expect(src).toMatch(/from '\.\/sdk\.gen\.ts'/);
    expect(src).toMatch(/type Options/);
  });

  it('imports the per-op Data type from types.gen', () => {
    // The Input override needs `${Op}Data` (from types.gen.ts) to do
    // `Omit<${Op}Data, slot>`. Imports must come through.
    const src = readGenerated();
    expect(src).toMatch(/from '\.\/types\.gen\.ts'/);
  });

  // ── SDK wrapper coverage (pass-through and encoding) ───────────────────────

  it('emits a pass-through wrapper for ops without registered input schemas', () => {
    // `getCodecObject`, `getScalarString`, etc. have no `request` block in
    // the fixture registry. The plugin still emits a wrapper so the auto-
    // generated `index.ts` has a single canonical export name per op
    // (with `includeInEntry: false` set on `@hey-api/sdk`, the SDK
    // plugin's emissions don't reach the barrel directly).
    //
    // Pass-throughs are zero-overhead `const X = X2` re-bindings — same
    // call signature as the upstream SDK function.
    const src = readGenerated();
    expect(src).toMatch(/^export const getCodecObject = getCodecObject2;$/m);
    expect(src).toMatch(/^export const getScalarString = getScalarString2;$/m);
    expect(src).toMatch(/^export const getErrorsOnly = getErrorsOnly2;$/m);
  });

  // ── Multi-slot routes (path + body) ────────────────────────────────────────

  it('emits Input artifacts for routes with multiple registered input slots', () => {
    // `updateOrder` declares both `params: OrderIdPathParams` AND
    // `body: UpdateOrderRequest`. The Input override carries both
    // codec-typed slots; the transformer's Pick covers both; the
    // transformer body's spread chain encodes each slot independently.
    const src = readGenerated();
    expect(src).toMatch(
      /export type UpdateOrderInput = Omit<UpdateOrderData, 'path' \| 'body'> & \{\s*path: z\.output<typeof OrderIdPathParams>;\s*body: z\.output<typeof UpdateOrderRequest>;\s*\};/
    );
    expect(src).toMatch(
      /export const updateOrderInputTransformer = async \(input: Pick<UpdateOrderInput, 'path' \| 'body'>\) => \(\{\s*\.\.\.input\.path !== undefined \? \{ path: await z\.encode\(OrderIdPathParams, input\.path\) \} : \{\},\s*\.\.\.input\.body !== undefined \? \{ body: await z\.encode\(UpdateOrderRequest, input\.body\) \} : \{\}\s*\}\);/
    );
    // Wrapper carries both encoded slots through the spread; cast targets the
    // SDK Data type because the merged structural type is the union of
    // runtime + wire shapes.
    expect(src).toMatch(
      /export const updateOrder = async <ThrowOnError extends boolean = false>\(options: Options<UpdateOrderInput, ThrowOnError>\) => \{\s*const transformed = await updateOrderInputTransformer\(options\);\s*return await updateOrder2\(\{ \.\.\.options, \.\.\.transformed \} as Options<UpdateOrderData, ThrowOnError>\);\s*\};/
    );
  });

  // ── Default-optional body (no `required: true`) ────────────────────────────

  it('emits an optional body slot when the route omits `required: true`', () => {
    // `submitForReview` has a body schema but does NOT set
    // `request.body.required`. asteasolutions defaults to optional in
    // the spec, hey-api emits `body?:` in `${Op}Data`, and our override
    // mirrors that. Wrapper's `options?:` follows because no slot is
    // required, so callers can write `submitForReview()` with no args.
    const src = readGenerated();
    expect(src).toMatch(
      /export type SubmitForReviewInput = Omit<SubmitForReviewData, 'body'> & \{\s*body\?: z\.output<typeof SubmitForReviewRequest>;\s*\};/
    );
    expect(src).toMatch(
      /export const submitForReview = async <ThrowOnError extends boolean = false>\(options\?: Options<SubmitForReviewInput, ThrowOnError>\) => \{/
    );
    // Wrapper coalesces undefined options before the transformer call —
    // `submitForReview()` with no args must not blow up on `input.body`
    // dereference inside the transformer.
    expect(src).toMatch(
      /const transformed = await submitForReviewInputTransformer\(options \?\? \{\}\);/
    );
  });
});
