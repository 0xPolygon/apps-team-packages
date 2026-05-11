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
    // Import line may be `{ z }` or `{ z, type ZodError }` depending on
    // whether the file also emits the wrapper-error classes — match
    // either by allowing additional names after `z`.
    const src = readGenerated();
    expect(src).toMatch(/import \{ z[,}][^}]*\} from 'zod'/);
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

  it('emits a typed-arrow pass-through for ops with no registered input AND no error schemas', () => {
    // `getCodecObject`, `getScalarString`, etc. have no `request` block in
    // the fixture registry AND no error responses. The plugin emits a
    // thin async arrow that forwards `options` to the upstream SDK
    // function — preserves the SDK's call signature and ThrowOnError
    // narrowing while keeping `wrapperFn.name === '${opId}'` (the older
    // `const X = X2` re-bind kept `name === '${opId}2'`, breaking
    // telemetry that introspects the canonical operation name).
    //
    // Ops with error schemas get a real wrapper instead so the wrapper
    // can decode `result.error` through the registered error schema (see
    // the error-transformer tests below); errors-only ops like
    // `getErrorsOnly` are no longer re-bound.
    const src = readGenerated();
    expect(src).toMatch(
      /export const getCodecObject = async <ThrowOnError extends boolean = false>\(options\?: Options<GetCodecObjectData, ThrowOnError>\) => await getCodecObject2\(options\);/
    );
    expect(src).toMatch(
      /export const getScalarString = async <ThrowOnError extends boolean = false>\(options\?: Options<GetScalarStringData, ThrowOnError>\) => await getScalarString2\(options\);/
    );
    expect(src).not.toMatch(/^export const getErrorsOnly = getErrorsOnly2;$/m);
  });

  it('preserves the canonical operation name on the pass-through wrapper at runtime', async () => {
    // Critical for telemetry / logging that introspects `fn.name` —
    // a re-bind form (`const getX = getX2`) keeps the auto-aliased
    // `getX2` as the function's name, which leaks into log lines and
    // error traces. The arrow form fixes that. This is a runtime
    // assertion against the generated client, not a textual check.
    const { getCodecObject: getCodecObjectWrapper } =
      await import('./__generated__/registry-validator.gen.ts');
    expect(getCodecObjectWrapper.name).toBe('getCodecObject');
  });

  // ── Error transformer + wrapper error decoding ─────────────────────────────

  it('emits an ${opId}ErrorTransformer for ops with declared error schemas', () => {
    // `createOrFetchResource` declares 400 + 404 + 500 with three distinct
    // schemas — the transformer must accept any of them, so the body is a
    // `z.union(...)` parse. Same shape as the response transformer for
    // multi-schema 2xx routes. The regex is whitespace-tolerant because
    // prettier may break the z.union(...) call across lines.
    const src = readGenerated();
    expect(src).toMatch(
      /export const createOrFetchResourceErrorTransformer = async \(data: unknown\): Promise<z\.output<typeof BadRequestError> \| z\.output<typeof NotFoundError> \| z\.output<typeof ServerError>> => await z\.union\(\[\s*BadRequestError,\s*NotFoundError,\s*ServerError\s*\]\)\.parseAsync\(data\);/
    );
    // `getErrorsOnly` declares two schemas (400, 500) — verify the union
    // form works there too. Two-element union typically renders inline.
    expect(src).toMatch(
      /export const getErrorsOnlyErrorTransformer = async \(data: unknown\): Promise<z\.output<typeof BadRequestError> \| z\.output<typeof ServerError>> => await z\.union\(\[\s*BadRequestError,\s*ServerError\s*\]\)\.parseAsync\(data\);/
    );
  });

  it('does not emit an ${opId}ErrorTransformer for ops with no error schemas', () => {
    // `getCodecObject` only has 200 — no error schemas, no error
    // transformer.
    const src = readGenerated();
    expect(src).not.toMatch(/getCodecObjectErrorTransformer/);
    expect(src).not.toMatch(/getScalarStringErrorTransformer/);
  });

  it('emits TransportError, UnknownError, the type guards, and the union guard', () => {
    // File-level scaffolding emitted lazily on first use. The two
    // classes plus their type-guard helpers give consumers a
    // symbol-based discriminator (cross-realm safe via `Symbol.for(...)`)
    // so they don't need `instanceof` at narrow sites.
    const src = readGenerated();
    // ZodError type imported from 'zod' (named, type-only).
    expect(src).toMatch(/import \{[^}]*\btype ZodError\b[^}]*\} from 'zod'/);
    // TransportError carries a symbol-keyed marker assigned in the
    // constructor — the cast to Record<symbol, unknown> is needed
    // because a class doesn't have a symbol index signature.
    // `@internal` JSDoc warns consumers off direct instantiation
    // (the wrapper produces these; consumer-thrown TransportError
    // would erode the discriminator's meaning).
    expect(src).toMatch(
      /\* @internal[\s\S]*?\* Narrow via the emitted `isTransportError`[\s\S]*?export class TransportError extends Error \{\s*readonly cause: Error;\s*constructor\(cause: Error\) \{\s*super\('Request failed before producing an HTTP response', \{ cause \}\);\s*\(this as Record<symbol, unknown>\)\[Symbol\.for\("@polygonlabs\/zod-to-openapi-heyapi\/is-transport-error"\)\] = true;/
    );
    // UnknownError adds a `body: unknown` field carrying the original
    // wire body — symmetric with `TransportError.cause` (one hop to
    // the underlying value). The two-arg constructor avoids the
    // earlier `Object.assign(zodError, { cause })` mutation
    // workaround.
    expect(src).toMatch(
      /\* @internal[\s\S]*?\* `body` is the original wire body[\s\S]*?export class UnknownError extends Error \{\s*readonly cause: ZodError;\s*readonly body: unknown;\s*constructor\(cause: ZodError, body: unknown\) \{\s*super\('API response did not match the registered schema', \{ cause \}\);\s*\(this as Record<symbol, unknown>\)\[Symbol\.for\("@polygonlabs\/zod-to-openapi-heyapi\/is-unknown-error"\)\] = true;\s*this\.cause = cause;\s*this\.name = 'UnknownError';\s*this\.body = body;/
    );
    // Type-guard helpers — the only consumer-visible narrowing API.
    // Type predicate `value is TransportError` lets call sites
    // narrow without `instanceof` (which fails across realms /
    // module copies); the symbol comparison is cross-realm safe
    // because `Symbol.for(...)` returns the same global symbol
    // regardless of which module copy of the generated client is
    // loaded.
    expect(src).toMatch(
      /export const isTransportError = \(value: unknown\): value is TransportError =>\s*typeof value === "object" && value !== null && \(value as Record<symbol, unknown>\)\[Symbol\.for\("@polygonlabs\/zod-to-openapi-heyapi\/is-transport-error"\)\] === true;/
    );
    expect(src).toMatch(
      /export const isUnknownError = \(value: unknown\): value is UnknownError =>\s*typeof value === "object" && value !== null && \(value as Record<symbol, unknown>\)\[Symbol\.for\("@polygonlabs\/zod-to-openapi-heyapi\/is-unknown-error"\)\] === true;/
    );
    // Union guard — for "any wrapper-emitted error" call sites
    // (logging / metrics) that don't care which category.
    expect(src).toMatch(
      /export const isWrapperError = \(value: unknown\): value is TransportError \| UnknownError =>\s*typeof value === "object" && value !== null && \(\(value as Record<symbol, unknown>\)\[Symbol\.for\("@polygonlabs\/zod-to-openapi-heyapi\/is-transport-error"\)\] === true \|\| \(value as Record<symbol, unknown>\)\[Symbol\.for\("@polygonlabs\/zod-to-openapi-heyapi\/is-unknown-error"\)\] === true\);/
    );
    // WrapErrors<TData, TError, ThrowOnError> — file-scope alias
    // wrappers reference for their explicit return-type annotation.
    // Mirrors hey-api's RequestResult<...>'s shape with
    // `TransportError | UnknownError` added to the no-throw error
    // union, so consumers see the widened error type at compile time
    // (not just at runtime). Single-Promise outer wrap so an `async
    // (): WrapErrors<...> =>` annotation satisfies TS's "must return
    // Promise<T>" rule (TS1064).
    expect(src).toMatch(
      /export type WrapErrors<TData, TError, ThrowOnError extends boolean> = Promise<\s*ThrowOnError extends true \?/
    );
    // Widening lands in the `error` slot of the no-throw branch.
    expect(src).toMatch(
      /error: \(TError extends Record<string, unknown> \? TError\[keyof TError\] : TError\) \| TransportError \| UnknownError;/
    );
  });

  it('emits a real wrapper that wraps transport vs validation errors distinctly', () => {
    // `createOrFetchResource` has no codec input, but it does declare error
    // schemas — so the wrapper is no longer a re-bind. The body wraps the
    // SDK call in try/catch and discriminates between transport (no HTTP
    // response) and validation (HTTP body didn't match schema) failures.
    // The wrapper's return-type annotation widens the error union so
    // consumers must narrow at compile time.
    const src = readGenerated();
    expect(src).toMatch(
      /export const createOrFetchResource = async <ThrowOnError extends boolean = false>\(options\?: Options<CreateOrFetchResourceData, ThrowOnError>\): WrapErrors<CreateOrFetchResourceResponses, CreateOrFetchResourceErrors, ThrowOnError> => \{/
    );
    // throwOnError: true catch block — discriminates via
    // `err instanceof Error` (reliable in the wrapper's same-realm
    // call site; replaces the earlier `'stack' in err` duck-typed
    // heuristic which was fragile against debug-mode servers that
    // include stack traces in error JSON), then either throws
    // TransportError (no parseAsync) or attempts parseAsync and
    // throws `UnknownError(zodError, wireBody)` on validation
    // failure.
    expect(src).toMatch(
      /catch \(err\) \{\s*if \(err instanceof Error\) \{\s*throw new TransportError\(err as Error\);\s*\}\s*let typedErr;\s*try \{\s*typedErr = await createOrFetchResourceErrorTransformer\(err\);\s*\}\s*catch \(validationError\) \{\s*throw new UnknownError\(validationError as ZodError, err\);\s*\}\s*throw typedErr;\s*\}/
    );
    // throwOnError: false path — decode result.error in place, with
    // the same transport / validation discrimination. `!= null`
    // (loose) covers `null` defensively. No catch-and-leave-as-wire
    // path (that would re-introduce the type/runtime gap); validation
    // failures land in `result.error` as UnknownError instances so
    // the type-level union of the result's error field stays honest.
    expect(src).toMatch(/const errorBearing = result as \{\s*error\?: unknown;\s*\};/);
    expect(src).toMatch(
      /if \(errorBearing\.error != null\) \{\s*if \(errorBearing\.error instanceof Error\) \{\s*errorBearing\.error = new TransportError\(errorBearing\.error as Error\);\s*\}\s*else \{\s*try \{\s*errorBearing\.error = await createOrFetchResourceErrorTransformer\(errorBearing\.error\);\s*\}\s*catch \(validationError\) \{\s*errorBearing\.error = new UnknownError\(validationError as ZodError, errorBearing\.error\);\s*\}\s*\}\s*\}/
    );
    // Return-type cast bridges the SDK's RequestResult<...> to the
    // wrapper's narrower WrapErrors<...> annotation. The cast is
    // internal to the generated wrapper; consumers see only the
    // widened return type and don't write any cast themselves.
    expect(src).toMatch(
      /return result as unknown as Awaited<WrapErrors<CreateOrFetchResourceResponses, CreateOrFetchResourceErrors, ThrowOnError>>;/
    );
  });

  it('combines input encoding AND error decoding when an op declares both', () => {
    // `createOrder` is the canonical mixed-pipeline op: it has a codec
    // body (`CreateOrderRequest` with `IsoDateCodec` + `Int64Codec`)
    // AND error responses (400 BadRequest, 500 Server). The wrapper's
    // body must run the input transformer first, then make the SDK
    // call, then split into transport / validation paths. Both transformer
    // calls must appear, in order.
    const src = readGenerated();
    expect(src).toMatch(/export const createOrderInputTransformer = /);
    expect(src).toMatch(/export const createOrderErrorTransformer = /);
    expect(src).toMatch(
      /createOrder = async[\s\S]*?const transformed = await createOrderInputTransformer\(options\);\s*let result;\s*try \{\s*result = await createOrder2\([^)]+\);\s*\}\s*catch \(err\) \{\s*if \(err instanceof Error\) \{\s*throw new TransportError\(err as Error\);\s*\}\s*let typedErr;\s*try \{\s*typedErr = await createOrderErrorTransformer\(err\);/
    );
  });

  it('does not emit an ErrorTransformer for codec-input ops with no declared errors', () => {
    // `lookupBlock` is codec-input (path: BlockNumberPathParams) with
    // ONLY a 200 response — no error schemas. The wrapper has the input
    // transform but no error-decoding scaffolding.
    const src = readGenerated();
    expect(src).not.toMatch(/lookupBlockErrorTransformer/);
    // Wrapper for lookupBlock is the simple input-encoding form (no
    // try/catch around the SDK call).
    expect(src).toMatch(
      /lookupBlock = async <ThrowOnError extends boolean = false>\(options: Options<LookupBlockInput, ThrowOnError>\) => \{\s*const transformed = await lookupBlockInputTransformer\(options\);\s*return await lookupBlock2\(/
    );
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

  // ── TanStack Query factory emission ────────────────────────────────────────

  describe('tanstackReactQuery option', () => {
    it('imports queryOptions and DefaultError from @tanstack/react-query', () => {
      // Ops with no Errors bucket fall back to DefaultError, so the type is
      // always referenced; queryOptions is the runtime call. Both must come
      // from the public package — that's what the consumer's runtime resolves
      // and what makes adding this option a real peer-dep change.
      const src = readGenerated();
      expect(src).toMatch(/import \{[^}]*\bqueryOptions\b[^}]*\} from '@tanstack\/react-query'/);
      expect(src).toMatch(
        /import \{[^}]*\btype DefaultError\b[^}]*\} from '@tanstack\/react-query'/
      );
    });

    it('emits the QueryKey type alias and createQueryKey utility once', () => {
      // Single emission only — the per-op factories share both. Multiple
      // declarations would be a duplicate-export TypeScript error, so the
      // assertion that there is exactly one of each catches a regression
      // where the scaffold-on-first-use guard breaks.
      const src = readGenerated();
      const queryKeyTypeMatches =
        src.match(/export type QueryKey<TOptions extends Options> = \[/g) ?? [];
      expect(queryKeyTypeMatches).toHaveLength(1);
      const createQueryKeyMatches = src.match(/^const createQueryKey = </gm) ?? [];
      expect(createQueryKeyMatches).toHaveLength(1);
    });

    it('does not emit factories for non-codec ops (upstream tanstack owns those)', () => {
      // The parser-level `isQuery` hook returns false for codec op ids,
      // so the upstream `@tanstack/react-query` plugin emits factories
      // for everything else. Our file must not duplicate those — same
      // names would collide via the entry barrel.
      const src = readGenerated();
      expect(src).not.toMatch(/export const getCodecObjectQueryKey\b/);
      expect(src).not.toMatch(/export const getCodecObjectOptions\b/);
      expect(src).not.toMatch(/export const getScalarStringQueryKey\b/);
      expect(src).not.toMatch(/export const getScalarStringOptions\b/);
    });

    it('upstream tanstack emits factories for non-codec ops in its own file', () => {
      // The mirror side of the gating: ops we skip must be emitted by
      // upstream so the consumer ends up with one factory per query op
      // overall. The upstream plugin's `includeInEntry` is hard-locked
      // false so its factories live in `@tanstack/react-query.gen.ts`,
      // separately from our entry barrel — consumers import from there
      // directly.
      const upstream = readFileSync(resolve(generatedDir, '@tanstack/react-query.gen.ts'), 'utf8');
      expect(upstream).toMatch(/export const getCodecObjectQueryKey\b/);
      expect(upstream).toMatch(/export const getScalarStringQueryKey\b/);
      // Codec ops are in OUR file, not here — same names, different
      // file, no collision because upstream skipped them.
      expect(upstream).not.toMatch(/export const lookupBlockQueryKey\b/);
      expect(upstream).not.toMatch(/export const createOrderQueryKey\b/);
    });

    it('emits a codec-aware factory typed against ${Op}Input for input-codec ops', () => {
      // `lookupBlock` has `params: BlockNumberPathParams` with Int64Codec.
      // The factory's options parameter is `Options<LookupBlockInput>` so
      // callers pass `{ blockNumber: bigint }` — the runtime shape — and
      // the factory pre-encodes to the wire string in the queryKey before
      // anything reaches `JSON.stringify`-based hashing.
      const src = readGenerated();
      expect(src).toMatch(
        /export const lookupBlockQueryKey = \(options: Options<LookupBlockInput>\) => createQueryKey\('lookupBlock', \{ \.\.\.options, \.\.\.options\?\.path !== undefined \? \{ path: z\.encode\(BlockNumberPathParams, options\?\.path\) \} : \{\} \} as Options<LookupBlockData>\);/
      );
      expect(src).toMatch(
        /export const lookupBlockOptions = \(options: Options<LookupBlockInput>\) => queryOptions<LookupBlockResponse, [^>]*LookupBlockResponse, ReturnType<typeof lookupBlockQueryKey>>\(/
      );
    });

    it('uses the Errors type as the queryOptions error generic when one exists', () => {
      // `lookupBlock` doesn't declare Errors → DefaultError. `createOrder`
      // (codec on body, plus 400 + 500 error responses in the fixture)
      // does, so the factory's error generic must be the
      // `${Op}Error` union — otherwise a caller reading `result.error`
      // would get `unknown` instead of the typed error body shapes.
      // `createOrFetchResource` has Errors but no codec input slot, so
      // its factory comes from upstream tanstack — not the right place
      // to test our error-generic logic.
      const src = readGenerated();
      expect(src).toMatch(
        /export const createOrderOptions = .* queryOptions<CreateOrderResponse, CreateOrderError, CreateOrderResponse, /
      );
    });

    it('encodes every codec-bearing slot for multi-slot routes', () => {
      // `updateOrder` has BOTH path (Int64Codec) AND body (mixed codecs).
      // Both slot conditionals must appear in the queryKey arg, otherwise
      // the unencoded slot's bigint/Date values would land in the
      // queryKey and trip `JSON.stringify` (or worse, a `String(date)`
      // locale collision).
      const src = readGenerated();
      expect(src).toMatch(
        /export const updateOrderQueryKey = \(options: Options<UpdateOrderInput>\) => createQueryKey\('updateOrder', \{[\s\S]*\.\.\.options\?\.path !== undefined \? \{ path: z\.encode\(OrderIdPathParams, options\?\.path\) \} : \{\},\s*\.\.\.options\?\.body !== undefined \? \{ body: z\.encode\(UpdateOrderRequest, options\?\.body\) \} : \{\}\s*\} as Options<UpdateOrderData>\);/
      );
    });

    it('calls the raw SDK function (alias `${opId}2`) inside queryFn, not the wrapper', () => {
      // The wrapper would re-encode the already-wire-shaped slots in
      // queryKey[0], producing nonsense. Confirm we go straight to the
      // upstream SDK plugin's function.
      const src = readGenerated();
      expect(src).toMatch(
        /lookupBlockOptions = .* queryFn: async \(\{ queryKey, signal \}\) => \{\s*const \{ data \} = await lookupBlock2\(/
      );
    });

    it('pins the ThrowOnError generic to true for codec ops to keep `data` non-undefined', () => {
      // The cast to `Options<${Op}Data>` strips `throwOnError: true`'s
      // literal narrowing — without pinning ThrowOnError, the SDK function
      // returns `data: T | undefined` and the queryFn's `Promise<T>`
      // contract fails. Every factory we emit goes through this path since
      // approach #2 means we only emit for codec ops.
      const src = readGenerated();
      expect(src).toMatch(/await lookupBlock2\([^)]*\} as Options<LookupBlockData, true>\);/);
      expect(src).toMatch(
        /await listRecentEvents2\([^)]*\} as Options<ListRecentEventsData, true>\);/
      );
      expect(src).toMatch(/await createOrder2\([^)]*\} as Options<CreateOrderData, true>\);/);
    });

    it('skips factory emission for errors-only operations', () => {
      // `getErrorsOnly` has no 2xx response, so there's no Response type to
      // parameterise queryOptions with. A factory that always returns an
      // error isn't a useful query surface — skip it (the upstream tanstack
      // plugin does the same via its `isQuery` hook).
      const src = readGenerated();
      expect(src).not.toMatch(/export const getErrorsOnlyQueryKey\b/);
      expect(src).not.toMatch(/export const getErrorsOnlyOptions\b/);
    });

    it('uses optional `options?` for routes whose ${Op}Data has no required slot', () => {
      // `submitForReview` has only an optional body — no required slot, so
      // the factory accepts `submitForReviewOptions()` with no args.
      const src = readGenerated();
      expect(src).toMatch(/export const submitForReviewOptions = \(options\?: /);
      expect(src).toMatch(/export const submitForReviewQueryKey = \(options\?: /);
    });

    it('uses required `options:` for routes whose ${Op}Data has at least one required slot', () => {
      // `lookupBlock`'s path slot is required (URL templates demand
      // interpolation values), so options must be required.
      const src = readGenerated();
      expect(src).toMatch(/export const lookupBlockOptions = \(options: /);
      expect(src).toMatch(/export const lookupBlockQueryKey = \(options: /);
    });
  });
});
