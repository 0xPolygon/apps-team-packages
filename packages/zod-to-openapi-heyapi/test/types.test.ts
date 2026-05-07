// Type-level smoke tests on the generated registry-validator.gen.ts.
//
// What this file proves: the plugin's emitted `Get*Response` types are
// `z.output<typeof Schema>` — exactly what `z.infer<typeof Schema>` produces.
// Once that's true for any one operation, it's true for every operation,
// because the plugin emits the same shape for all of them. So the assertions
// here are a *smoke test that the wiring works*, not a per-construct
// validation of TypeScript's type inference (which is Zod's responsibility,
// not the plugin's).
//
// Pick one schema-with-codecs and one Date codec — enough to fail loudly if
// the plugin starts emitting something other than z.output<typeof X>.

import { describe, it } from 'vitest';

import type {
  getCodecObjectOptions,
  getCodecObjectQueryKey
} from './__generated__/@tanstack/react-query.gen.ts';
import type {
  createOrFetchResource,
  createOrder,
  CreateOrderInput,
  CreateOrFetchResourceError,
  CreateOrFetchResourceErrors,
  CreateOrFetchResourceResponse,
  CreateOrFetchResourceResponses,
  createOrderOptions,
  getCodecObject,
  GetCodecObjectResponse,
  GetCodecObjectResponses,
  GetDateFieldResponse,
  getErrorsOnly,
  ListRecentEventsInput,
  listRecentEventsOptions,
  listRecentEventsQueryKey,
  lookupBlock,
  LookupBlockInput,
  lookupBlockOptions,
  lookupBlockQueryKey,
  SubmitForReviewInput,
  submitForReviewOptions,
  UpdateOrderInput
} from './__generated__/registry-validator.gen.ts';
// Raw SDK functions used as the type-level "ground truth" — we want our
// wrappers' return types to match these exactly, so the codec promises
// the response transformer makes (success body) and the error
// transformer makes (error body) reach the caller as-is.
import type {
  createOrFetchResource as createOrFetchResourceSdk,
  createOrder as createOrderSdk,
  getCodecObject as getCodecObjectSdk,
  getErrorsOnly as getErrorsOnlySdk,
  lookupBlock as lookupBlockSdk
} from './__generated__/sdk.gen.ts';
import type * as schemas from './fixtures/schemas.ts';
import type { z } from './fixtures/zod.ts';

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type Assertions = [
  // ── Single-status path — the plugin's basic contract ────────────────────────
  // `${Op}Responses` is keyed by the actual status code (here, 200).
  Expect<Equal<GetCodecObjectResponses, { 200: z.output<typeof schemas.CodecObject> }>>,
  // `${Op}Response = Responses[keyof Responses]` — the union of status bodies.
  Expect<Equal<GetCodecObjectResponse, z.output<typeof schemas.CodecObject>>>,

  // Sanity check on a non-trivial codec: ISO-string→Date round-trips through
  // the same `pipe → out` path int64 codecs use. If this lands as `string`,
  // codec output handling is broken.
  Expect<Equal<GetDateFieldResponse['occurredAt'], Date>>,

  // ── Multi-status path — Responses + Errors ──────────────────────────────────
  // `createOrFetchResource` defines 200 + 201 success and 400 + 404 + 500 errors.
  Expect<
    Equal<
      CreateOrFetchResourceResponses,
      {
        200: z.output<typeof schemas.ResourceFetched>;
        201: z.output<typeof schemas.ResourceCreated>;
      }
    >
  >,
  // The Response union spans both 2xx bodies.
  Expect<
    Equal<
      CreateOrFetchResourceResponse,
      z.output<typeof schemas.ResourceFetched> | z.output<typeof schemas.ResourceCreated>
    >
  >,
  Expect<
    Equal<
      CreateOrFetchResourceErrors,
      {
        400: z.output<typeof schemas.BadRequestError>;
        404: z.output<typeof schemas.NotFoundError>;
        500: z.output<typeof schemas.ServerError>;
      }
    >
  >,
  // Error union spans every error body — including codec-bearing ServerError
  // (proves error responses get the same codec-aware typing as success ones).
  Expect<
    Equal<
      CreateOrFetchResourceError,
      | z.output<typeof schemas.BadRequestError>
      | z.output<typeof schemas.NotFoundError>
      | z.output<typeof schemas.ServerError>
    >
  >,

  // ── Input-side codec encoding ───────────────────────────────────────────────
  //
  // The whole reason this work exists: callers should pass the runtime
  // shape (e.g. `bigint` for `Int64Codec`, `Date` for `IsoDateCodec`) on
  // the request side, just as they receive it on the response side. The
  // plugin's emitted `${Op}Input` types are `z.output<typeof Schema>` for
  // the slots backed by a registered schema — same machinery as responses,
  // applied to the request.

  // Path codec: `lookupBlock` declares `params: BlockNumberPathParams`
  // with `blockNumber: Int64Codec`. Path slot is required in `${Op}Data`
  // (URL templates need their interpolation values), so the Input slot
  // is required too. Value type is `bigint`, not the wire `string`.
  Expect<Equal<LookupBlockInput['path'], z.output<typeof schemas.BlockNumberPathParams>>>,
  Expect<Equal<LookupBlockInput['path']['blockNumber'], bigint>>,

  // Query codec + optionality preservation: `listRecentEvents` declares
  // `query: RecentEventsQuery` with `since: IsoDateCodec.optional()`.
  // Since the only field is optional, no query param is required, so
  // hey-api emits `query?: ...` in `${Op}Data` — and `${Op}Input` mirrors
  // that. Caller can omit the slot entirely; doesn't have to pass
  // `{ query: {} }`.
  Expect<
    Equal<NonNullable<ListRecentEventsInput['query']>, z.output<typeof schemas.RecentEventsQuery>>
  >,
  // The slot itself is optional — undefined extends the slot type.
  Expect<undefined extends ListRecentEventsInput['query'] ? true : false>,

  // Body codec + explicit-required: `createOrder`'s route config sets
  // `body: { required: true, ... }`, so `${Op}Data.body` is required and
  // `${Op}Input.body` follows. Without `required: true`, asteasolutions
  // defaults to optional and the slot would carry `undefined` here.
  Expect<Equal<CreateOrderInput['body'], z.output<typeof schemas.CreateOrderRequest>>>,
  Expect<Equal<CreateOrderInput['body']['priority'], bigint>>,
  Expect<Equal<CreateOrderInput['body']['scheduledFor'], Date>>,
  Expect<Equal<CreateOrderInput['body']['reference'], string>>,

  // Multi-slot route (path + body): `updateOrder` declares both
  // `params: OrderIdPathParams` (Int64Codec → bigint) and
  // `body: UpdateOrderRequest`. Both slots get runtime types in
  // ${Op}Input simultaneously.
  Expect<Equal<UpdateOrderInput['path']['orderId'], bigint>>,
  Expect<Equal<NonNullable<UpdateOrderInput['body']>['scheduledFor'], Date | undefined>>,
  Expect<Equal<NonNullable<UpdateOrderInput['body']>['priority'], bigint | undefined>>,

  // Default-optional body: `submitForReview`'s route config has body
  // WITHOUT `required: true`, so the slot is optional in ${Op}Input
  // and the wrapper accepts no args.
  Expect<undefined extends SubmitForReviewInput['body'] ? true : false>,

  // ── TanStack Query factory parameter typing ─────────────────────────────────
  //
  // The point of the factory codegen is that callers pass codec runtime
  // shapes (bigint, Date) on the request side — same as they receive on
  // the response side. The factory's `options` parameter type, surfaced as
  // `Parameters<typeof factory>[0]`, must mirror `${Op}Input` for codec ops
  // and `${Op}Data` for non-codec ops. If the factory regresses to wire
  // shapes, callers would have to pre-encode every request to use the
  // factory, defeating the codec round-trip.

  // Codec on path: bigint flows through to the factory parameter.
  Expect<
    Equal<NonNullable<Parameters<typeof lookupBlockQueryKey>[0]>['path']['blockNumber'], bigint>
  >,
  Expect<
    Equal<NonNullable<Parameters<typeof lookupBlockOptions>[0]>['path']['blockNumber'], bigint>
  >,

  // Codec on query, optional: `since` is `Date | undefined` — runtime shape,
  // not a wire ISO string. Optional propagates from the underlying ${Op}Data.
  Expect<
    Equal<
      NonNullable<NonNullable<Parameters<typeof listRecentEventsQueryKey>[0]>['query']>['since'],
      Date | undefined
    >
  >,
  Expect<
    Equal<
      NonNullable<NonNullable<Parameters<typeof listRecentEventsOptions>[0]>['query']>['since'],
      Date | undefined
    >
  >,

  // Codec on body: priority is bigint, scheduledFor is Date.
  Expect<Equal<NonNullable<Parameters<typeof createOrderOptions>[0]>['body']['priority'], bigint>>,
  Expect<
    Equal<NonNullable<Parameters<typeof createOrderOptions>[0]>['body']['scheduledFor'], Date>
  >,

  // No registered input — factory takes `${Op}Data` directly. The slot
  // shape is whatever the SDK plugin emitted (here, no slots). The
  // important assertion is that the factory parameter is `Options<...Data>`,
  // not `Options<...Input>` (which doesn't exist for this op).
  Expect<undefined extends Parameters<typeof getCodecObjectQueryKey>[0] ? true : false>,
  Expect<undefined extends Parameters<typeof getCodecObjectOptions>[0] ? true : false>,

  // Routes whose ${Op}Data has no required slot accept a no-arg call.
  Expect<undefined extends Parameters<typeof submitForReviewOptions>[0] ? true : false>,

  // ── SDK wrapper return-type parity ─────────────────────────────────
  //
  // Four flavours of wrapper, all of which must return *exactly* what
  // the upstream raw SDK function returns — same `ThrowOnError`
  // overload narrowing, same discriminated union for the
  // throwOnError: false case, same codec-decoded error shapes. The
  // SDK function's types are the ground truth (its `${Op}Error` is
  // already `z.output<…>` from this plugin). If the wrapper's return
  // type drifts from the SDK's, our codec promises break either on
  // the success path (`data: T | undefined` instead of `T` when
  // `throwOnError: true`) or the error path (`error.traceId: string`
  // instead of `bigint`). Asserting equality between wrapper and SDK
  // return types catches both regressions.

  // Pass-through (no input, no errors).
  Expect<
    Equal<Awaited<ReturnType<typeof getCodecObject>>, Awaited<ReturnType<typeof getCodecObjectSdk>>>
  >,
  // Same wrapper with throwOnError: true narrowing.
  Expect<
    Equal<
      Awaited<ReturnType<typeof getCodecObject<true>>>,
      Awaited<ReturnType<typeof getCodecObjectSdk<true>>>
    >
  >,

  // Codec-input wrapper.
  Expect<
    Equal<
      Awaited<ReturnType<typeof lookupBlock<true>>>,
      Awaited<ReturnType<typeof lookupBlockSdk<true>>>
    >
  >,

  // Error-decoding wrapper. Preserving the SDK return type means
  // `result.error.traceId` is `bigint` (Int64Codec runtime), not
  // `string` (the wire shape). The runtime test in api.test.ts
  // proves the runtime decode actually happens; this assertion
  // proves the type contract the wrapper makes still aligns with
  // what the SDK function declared.
  Expect<
    Equal<
      Awaited<ReturnType<typeof createOrFetchResource>>,
      Awaited<ReturnType<typeof createOrFetchResourceSdk>>
    >
  >,

  // Combined codec-input + error-decoding op.
  Expect<
    Equal<
      Awaited<ReturnType<typeof createOrder<true>>>,
      Awaited<ReturnType<typeof createOrderSdk<true>>>
    >
  >,

  // Errors-only op.
  Expect<
    Equal<Awaited<ReturnType<typeof getErrorsOnly>>, Awaited<ReturnType<typeof getErrorsOnlySdk>>>
  >
];

const _assertions: Assertions | undefined = undefined;
void _assertions;

describe('generated types are z.output<typeof Schema>', () => {
  it('compiles', () => {
    // Compile-time assertions above are the actual test.
  });
});
