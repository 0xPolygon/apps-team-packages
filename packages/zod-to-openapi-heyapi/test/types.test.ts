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

// Test-internal raw SDK access — used as the type-level "ground truth"
// for the non-error-widening wrappers (`getCodecObject`, `lookupBlock`)
// where the wrapper must return *exactly* what the raw SDK function
// returns. Wrappers that widen errors (`createOrFetchResource`,
// `createOrder`, `getErrorsOnly`) deliberately diverge and assert
// against `WrapErrors<...>` shapes instead, so they don't pull SDK
// aliases. See `_test-internals.ts` for why this access is segregated
// from the consumer-facing public surface.
import type {
  _TestInternal_createOrderSdk,
  _TestInternal_createOrFetchResourceSdk,
  _TestInternal_getCodecObjectSdk,
  _TestInternal_getErrorsOnlySdk,
  _TestInternal_lookupBlockSdk
} from './_test-internals.ts';
import type * as schemas from './fixtures/schemas.ts';
import type { z } from './fixtures/zod.ts';
// Consumer-facing surface — same path a real consumer would import
// from (`@my-org/api-client`). Catches barrel regressions: if the
// plugin emits a symbol but forgets to publish it, this import
// breaks at compile time.
import type {
  createOrFetchResource,
  createOrder,
  CreateOrderError,
  CreateOrderInput,
  CreateOrderResponse,
  CreateOrFetchResourceError,
  CreateOrFetchResourceErrors,
  CreateOrFetchResourceResponse,
  CreateOrFetchResourceResponses,
  createOrderOptions,
  getCodecObject,
  GetCodecObjectResponse,
  getCodecObjectOptions,
  getCodecObjectQueryKey,
  GetCodecObjectResponses,
  GetDateFieldResponse,
  getErrorsOnly,
  GetErrorsOnlyError,
  ListRecentEventsInput,
  listRecentEventsOptions,
  listRecentEventsQueryKey,
  lookupBlock,
  LookupBlockInput,
  lookupBlockOptions,
  lookupBlockQueryKey,
  SubmitForReviewInput,
  submitForReviewOptions,
  TransportError,
  ResponseValidationError,
  UpdateOrderInput
} from './public-client.ts';

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

  // Pass-through (no input, no errors). The wrapper's return shape
  // is `WrapPassThrough<TData, ThrowOnError, TResponseStyle>` —
  // structurally a `RequestResult<TData, unknown, ThrowOnError,
  // TResponseStyle>` (same discriminated union for 'fields', flat
  // value for 'data'). The TYPE-AS-ALIAS-NAMES differ between
  // `WrapPassThrough` and hey-api's `RequestResult`, so structural
  // `Equal<>` against the SDK return type would fail on the
  // conditional-type instance check even when the resolved shapes
  // match.
  //
  // Instead, pin the wrapper's data field equality against the SDK's
  // — that's the contract that actually matters at consumer call
  // sites (the `request` / `response` envelope is fixed boilerplate;
  // the typed data is what TS narrows on).
  Expect<
    Equal<
      Awaited<ReturnType<typeof getCodecObject<true>>>['data'],
      Awaited<ReturnType<typeof _TestInternal_getCodecObjectSdk<true>>>['data']
    >
  >,
  // throwOnError: false: the wrapper's data field on the success
  // branch should match the SDK's union. We project the success
  // branch via `Extract<…, { error: undefined }>` so the narrow
  // resolves on both sides.
  Expect<
    Equal<
      Extract<Awaited<ReturnType<typeof getCodecObject<false>>>, { error: undefined }>['data'],
      Extract<
        Awaited<ReturnType<typeof _TestInternal_getCodecObjectSdk<false>>>,
        { error: undefined }
      >['data']
    >
  >,

  // Codec-input wrapper, data-field parity in throw mode (success-path).
  Expect<
    Equal<
      Awaited<ReturnType<typeof lookupBlock<true>>>['data'],
      Awaited<ReturnType<typeof _TestInternal_lookupBlockSdk<true>>>['data']
    >
  >,

  // Error-decoding wrapper widens `result.error` to include the
  // wrapper-emitted `TransportError` / `ResponseValidationError` classes — the
  // wrapper return type *deliberately differs* from the SDK return
  // type. Preserves codec runtime shapes for typed errors
  // (`result.error.traceId` is `bigint`, not the wire `string`) AND
  // forces consumers to narrow before reaching typed-error fields.
  // If this assertion ever loses the wrapper-error union, consumers
  // re-introduce the silent `result.error.<typed-field>`-on-runtime-
  // `ResponseValidationError` bug. `<false>` pins the throwOnError-false branch
  // of the conditional return type so we can read `.error` directly
  // without union-distribution gymnastics.
  Expect<
    Equal<
      Awaited<ReturnType<typeof createOrFetchResource<false>>>['error'],
      CreateOrFetchResourceError | TransportError | ResponseValidationError | undefined
    >
  >,

  // Combined codec-input + error-decoding op.
  Expect<
    Equal<
      Awaited<ReturnType<typeof createOrder<false>>>['error'],
      CreateOrderError | TransportError | ResponseValidationError | undefined
    >
  >,

  // Errors-only op (no 2xx schemas registered) — `WrapErrors<unknown,
  // GetErrorsOnlyErrors, ThrowOnError>` still widens the error union.
  Expect<
    Equal<
      Awaited<ReturnType<typeof getErrorsOnly<false>>>['error'],
      GetErrorsOnlyError | TransportError | ResponseValidationError | undefined
    >
  >,

  // ── Data-field parity for error-widening wrappers ───────────────────────────
  //
  // The error-widening wrappers above pin `['error']`. They MUST NOT
  // also widen `['data']` — the data branch should match the raw SDK
  // function's data exactly. A regression that drops the narrow data
  // type for these wrappers (e.g., re-emits the SDK success shape as
  // `unknown`) would silently propagate `any`-flavoured values into
  // consumer code. Asserting equality against the raw SDK's `['data']`
  // pins this contract without re-stating the shape literally (which
  // would drift if the underlying schema changes).
  Expect<
    Equal<
      Awaited<ReturnType<typeof createOrFetchResource<false>>>['data'],
      Awaited<ReturnType<typeof _TestInternal_createOrFetchResourceSdk<false>>>['data']
    >
  >,
  Expect<
    Equal<
      Awaited<ReturnType<typeof createOrder<false>>>['data'],
      Awaited<ReturnType<typeof _TestInternal_createOrderSdk<false>>>['data']
    >
  >,
  Expect<
    Equal<
      Awaited<ReturnType<typeof getErrorsOnly<false>>>['data'],
      Awaited<ReturnType<typeof _TestInternal_getErrorsOnlySdk<false>>>['data']
    >
  >,

  // ── responseStyle threading ─────────────────────────────────────────────────
  //
  // The wrapper signature carries a fourth `TResponseStyle` generic
  // that threads through `WrapErrors` and conditionally produces
  // hey-api's 'fields' or 'data' return shape. These assertions pin
  // the four-cell matrix (style × throwOnError) so a regression in
  // any branch surfaces at typecheck.
  //
  // The runtime equivalents — proving the wrapper actually returns
  // the shape claimed here, in both styles — live in
  // api-errors.test.ts (data-style scenarios) and api.test.ts
  // (fields-style is the default; covered throughout).

  // 'fields' (default) + throwOnError: true → { data; request; response }
  Expect<
    Equal<
      Awaited<ReturnType<typeof getCodecObject<true, 'fields'>>>,
      { data: GetCodecObjectResponse; request: Request; response: Response }
    >
  >,

  // 'fields' (default) + throwOnError: false → discriminated union
  // with wrapper-error union on the error path.
  Expect<
    Equal<
      Awaited<ReturnType<typeof createOrder<false, 'fields'>>>['error'],
      CreateOrderError | TransportError | ResponseValidationError | undefined
    >
  >,

  // 'data' + throwOnError: true → flat data (no envelope, no
  // request/response, no error slot — errors throw).
  Expect<Equal<Awaited<ReturnType<typeof getCodecObject<true, 'data'>>>, GetCodecObjectResponse>>,

  // 'data' + throwOnError: false → flat data | undefined.
  // No discriminated union; hey-api's 'data' style swallows errors as
  // `undefined`, so there's no slot for wrapper errors here.
  // Consumers wanting wrapper-error narrowing in 'data' mode use
  // throwOnError: true and catch.
  Expect<
    Equal<
      Awaited<ReturnType<typeof getCodecObject<false, 'data'>>>,
      GetCodecObjectResponse | undefined
    >
  >,
  // For 'data' mode, the no-throw branch is just the throw-branch
  // value plus `undefined` (errors swallow to undefined). Cross-check
  // the two ways the wrapper can be parametrised produce consistent
  // shapes.
  Expect<
    Equal<
      Awaited<ReturnType<typeof createOrder<false, 'data'>>>,
      Awaited<ReturnType<typeof createOrder<true, 'data'>>> | undefined
    >
  >,

  // Errors-only op + 'data' style: TData is `unknown`, so the
  // flattened-data shape collapses to `unknown` (and `unknown |
  // undefined` simplifies back to `unknown`).
  Expect<Equal<Awaited<ReturnType<typeof getErrorsOnly<false, 'data'>>>, unknown>>,

  // ── Cross-check: 'data' shape parity vs the raw SDK ─────────────────────────
  //
  // Hey-api's SDK plugin doesn't thread `TResponseStyle` through the
  // raw SDK function's signature, but the underlying client's
  // `RequestResult` does (the same shape `WrapErrors` mirrors). The
  // wrapper's per-call generic should produce the same 'data'-style
  // shapes hey-api would in pre-throwing mode.
  Expect<
    Equal<
      Awaited<ReturnType<typeof getCodecObject<true, 'data'>>>,
      Awaited<ReturnType<typeof _TestInternal_getCodecObjectSdk<true>>>['data']
    >
  >,

  // ── WrapErrors style × throwOnError matrix (error-widening wrappers) ────────
  //
  // The four cells of the matrix for ops with declared error schemas.
  // The error-union cell (style='fields', throwOnError=false) is
  // pinned above; these complete the matrix.

  // 'fields' + throwOnError: true → { data; request; response }.
  // No error field — errors throw; the wrapper's catch wraps them as
  // TransportError / ResponseValidationError / typed `${Op}Error`,
  // surfaced via the consumer's `catch` block (where the value is
  // `unknown` and the codegen-emitted predicates narrow it). Pinning
  // the return-side here proves the no-error-field shape lands.
  Expect<
    Equal<
      Awaited<ReturnType<typeof createOrFetchResource<true, 'fields'>>>,
      {
        data: CreateOrFetchResourceResponse;
        request: Request;
        response: Response;
      }
    >
  >,

  // 'data' + throwOnError: true → flat data. Same hey-api shape as
  // pass-through 'data' + true, but for an error-widening wrapper.
  Expect<
    Equal<
      Awaited<ReturnType<typeof createOrFetchResource<true, 'data'>>>,
      CreateOrFetchResourceResponse
    >
  >,
  Expect<Equal<Awaited<ReturnType<typeof createOrder<true, 'data'>>>, CreateOrderResponse>>,
  // Errors-only op + 'data' + throwOnError: true → unknown (no 2xx
  // schema means no data to type; hey-api would only throw at runtime).
  Expect<Equal<Awaited<ReturnType<typeof getErrorsOnly<true, 'data'>>>, unknown>>,

  // ── WrapPassThrough style × throwOnError matrix completion ──────────────────
  //
  // Pass-through ops use the narrower `WrapPassThrough` alias. The
  // 'fields' + throwOnError: false cell is the discriminated union
  // with a bare `unknown` error (no wrapper-error union — pass-through
  // wrappers don't wrap errors at runtime).
  Expect<Equal<Awaited<ReturnType<typeof getCodecObject<false, 'fields'>>>['error'], unknown>>,
  Expect<
    Equal<
      Extract<
        Awaited<ReturnType<typeof getCodecObject<false, 'fields'>>>,
        { error: undefined }
      >['data'],
      GetCodecObjectResponse
    >
  >
];

const _assertions: Assertions | undefined = undefined;
void _assertions;

describe('generated types are z.output<typeof Schema>', () => {
  it('compiles', () => {
    // Compile-time assertions above are the actual test.
  });
});
