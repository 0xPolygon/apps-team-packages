// End-to-end tests against the generated client.
//
// MSW handlers stub the wire body, the generated SDK function makes a real
// fetch against a fake baseUrl, the response runs through the plugin's
// transformer, and assertions check the decoded values — exercising the
// full codegen → import → fetch → transformer → caller pipeline. Proves
// the plugin's emit produces a working client, not just textually-correct
// output.

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { client } from './__generated__/client.gen.ts';
import {
  createOrder,
  createOrderOptions,
  createOrFetchResource as createOrFetchResourceWrapper,
  getErrorsOnly as getErrorsOnlyWrapper,
  isTransportError,
  isUnknownError,
  listRecentEvents,
  lookupBlock,
  lookupBlockOptions,
  lookupBlockQueryKey,
  submitForReview,
  updateOrder
} from './__generated__/registry-validator.gen.ts';
import {
  createOrFetchResource,
  getCodecObject,
  getDateField,
  getErrorsOnly,
  getScalarString
} from './__generated__/sdk.gen.ts';

const BASE_URL = 'http://api.test';
const server = setupServer();

beforeAll(() => {
  client.setConfig({ baseUrl: BASE_URL });
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
  // Reset client between tests — important when individual tests change
  // throwOnError or responseStyle.
  client.setConfig({ throwOnError: false, responseStyle: 'fields' });
});

afterAll(() => server.close());

describe('codec round-trip via the response transformer', () => {
  it('decodes int64 wire strings to bigint and decimalString stays string', async () => {
    server.use(
      http.get(`${BASE_URL}/fixtures/getCodecObject`, () =>
        HttpResponse.json({
          id: 'tx_001',
          // Wire format — string. The Int64Codec decode side runs at parseAsync
          // and produces a bigint.
          amount: '999999999999',
          currency: 'USD',
          // decimalString stays a string (validated as decimal at the codec input).
          fee: '1.50',
          createdAt: '2025-01-15T10:00:00Z'
        })
      )
    );

    const { data, error } = await getCodecObject();
    expect(error).toBeUndefined();
    expect(data).toBeDefined();
    expect(typeof data!.amount).toBe('bigint');
    expect(data!.amount).toBe(999999999999n);
    expect(typeof data!.fee).toBe('string');
    expect(data!.fee).toBe('1.50');
    expect(data!.id).toBe('tx_001');
  });

  it('decodes ISO datetime wire strings to Date instances', async () => {
    server.use(
      http.get(`${BASE_URL}/fixtures/getDateField`, () =>
        HttpResponse.json({ occurredAt: '2025-04-28T13:45:00Z' })
      )
    );

    const { data } = await getDateField();
    expect(data!.occurredAt).toBeInstanceOf(Date);
    expect(data!.occurredAt.toISOString()).toBe('2025-04-28T13:45:00.000Z');
  });

  it('passes through non-codec scalars unchanged', async () => {
    server.use(
      http.get(`${BASE_URL}/fixtures/getScalarString`, () => HttpResponse.json({ value: 'plain' }))
    );

    const { data } = await getScalarString();
    expect(data!.value).toBe('plain');
  });

  it('throws via parseAsync when the wire data is malformed', async () => {
    server.use(
      http.get(`${BASE_URL}/fixtures/getCodecObject`, () =>
        // `amount` should be a digit string. The regex on Int64Codec's input
        // schema rejects 'not-a-number' before BigInt() is ever called.
        HttpResponse.json({
          id: 'tx_bad',
          amount: 'not-a-number',
          currency: 'USD',
          fee: '0',
          createdAt: '2025-01-15T10:00:00Z'
        })
      )
    );

    // throwOnError: true makes the rejection surface as a thrown promise.
    await expect(getCodecObject({ throwOnError: true })).rejects.toThrow();
  });
});

describe('multi-status responses', () => {
  it('decodes the 200 response shape (ResourceFetched) via the union transformer', async () => {
    server.use(
      http.post(`${BASE_URL}/fixtures/createOrFetch`, () =>
        HttpResponse.json({ id: 'res_1', data: 'hello' }, { status: 200 })
      )
    );

    const { data, error } = await createOrFetchResource();
    expect(error).toBeUndefined();
    // ResourceFetched: { id, data }
    expect(data).toMatchObject({ id: 'res_1', data: 'hello' });
  });

  it('decodes the 201 response shape (ResourceCreated) via the same transformer', async () => {
    // The transformer is `z.union([ResourceFetched, ResourceCreated]).parseAsync(data)`.
    // ResourceCreated.createdAt is an ISO codec → Date at runtime. If the
    // transformer were bound only to ResourceFetched, this parse would throw.
    server.use(
      http.post(`${BASE_URL}/fixtures/createOrFetch`, () =>
        HttpResponse.json({ id: 'res_2', createdAt: '2025-04-28T14:00:00Z' }, { status: 201 })
      )
    );

    const { data, error } = await createOrFetchResource();
    expect(error).toBeUndefined();
    expect(data).toBeDefined();
    // Narrow to the createdAt branch.
    if (data && 'createdAt' in data) {
      expect(data.id).toBe('res_2');
      expect(data.createdAt).toBeInstanceOf(Date);
    } else {
      throw new Error('expected ResourceCreated branch with createdAt');
    }
  });

  it('exposes 4xx error bodies on the error field, not data', async () => {
    server.use(
      http.post(`${BASE_URL}/fixtures/createOrFetch`, () =>
        HttpResponse.json(
          { code: 'bad_request', message: 'missing id', fieldErrors: { id: 'required' } },
          { status: 400 }
        )
      )
    );

    const { data, error } = await createOrFetchResource();
    expect(data).toBeUndefined();
    expect(error).toBeDefined();
    // The error body is unparsed JSON — error responses don't run the transformer.
    expect(error).toMatchObject({
      code: 'bad_request',
      message: 'missing id',
      fieldErrors: { id: 'required' }
    });
  });

  it('exposes 5xx error bodies on the error field', async () => {
    server.use(
      http.post(`${BASE_URL}/fixtures/createOrFetch`, () =>
        HttpResponse.json(
          { code: 'internal_error', message: 'kaboom', traceId: '123456789' },
          { status: 500 }
        )
      )
    );

    const { error } = await createOrFetchResource();
    expect(error).toBeDefined();
    expect(error).toMatchObject({ code: 'internal_error', message: 'kaboom' });
  });

  it('handles errors-only operations (no transformer wired)', async () => {
    // getErrorsOnly has no 2xx — so the SDK function exists but never runs
    // the transformer. A 400 response surfaces as `error`.
    server.use(
      http.get(`${BASE_URL}/fixtures/errorsOnly`, () =>
        HttpResponse.json({ code: 'bad_request', message: 'no' }, { status: 400 })
      )
    );

    const { data, error } = await getErrorsOnly();
    expect(data).toBeUndefined();
    expect(error).toMatchObject({ code: 'bad_request' });
  });
});

describe('input-side codec encoding via the SDK wrapper', () => {
  it('encodes a bigint path param to the wire string before URL interpolation', async () => {
    // Caller passes `bigint`; `Int64Codec.encode = (b) => b.toString()`, so
    // the URL must contain the digit string. Without the input transformer
    // the path serialiser would call `String(bigint)` — which happens to
    // produce the same digits — so this test alone doesn't prove the
    // transformer runs. The query / date case below does.
    let url: string | undefined;
    server.use(
      http.get(`${BASE_URL}/fixtures/blocks/:blockNumber`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({ value: 'ok' });
      })
    );

    const { data } = await lookupBlock({ path: { blockNumber: 9007199254740993n } });
    expect(data).toEqual({ value: 'ok' });
    expect(url).toContain('/fixtures/blocks/9007199254740993');
  });

  it('encodes a Date query param to ISO 8601 — the case that fails without the transformer', async () => {
    // The codec-on-query stress test. `String(date)` emits the locale
    // string ("Tue Apr 28 2026 14:45:00 GMT+0100 (...)"); only the input
    // transformer (z.encode → IsoDateCodec.encode → toISOString()) produces
    // the wire ISO string. If this test passes the encoder is firing.
    let url: string | undefined;
    server.use(
      http.get(`${BASE_URL}/fixtures/events`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({ value: 'ok' });
      })
    );

    const since = new Date('2026-04-28T13:45:00.000Z');
    const { data } = await listRecentEvents({ query: { since } });
    expect(data).toEqual({ value: 'ok' });
    expect(url).toBeDefined();
    const parsed = new URL(url!);
    expect(parsed.searchParams.get('since')).toBe('2026-04-28T13:45:00.000Z');
  });

  it('omits an optional codec query field when the caller passes undefined', async () => {
    // `since: IsoDateCodec.optional()` — passing undefined should produce
    // a URL without `since=...`. `z.encode` of undefined on an optional
    // schema is undefined, which the query serialiser drops.
    let url: string | undefined;
    server.use(
      http.get(`${BASE_URL}/fixtures/events`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({ value: 'ok' });
      })
    );

    const { data } = await listRecentEvents({ query: { since: undefined } });
    expect(data).toEqual({ value: 'ok' });
    const parsed = new URL(url!);
    expect(parsed.searchParams.has('since')).toBe(false);
  });

  it('encodes mixed codec / non-codec body fields before serialising', async () => {
    // Body: `{ reference: string, scheduledFor: Date, priority: bigint }`.
    // `JSON.stringify` outright throws on bigint, so without the transformer
    // this would fail at the serialiser. After encoding: a digit string for
    // `priority`, an ISO string for `scheduledFor`, and the plain string
    // for `reference`.
    let body: unknown;
    server.use(
      http.post(`${BASE_URL}/fixtures/orders`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ value: 'ok' });
      })
    );

    const { data } = await createOrder({
      body: {
        reference: 'order-1',
        scheduledFor: new Date('2026-05-01T09:00:00.000Z'),
        priority: 9007199254740993n
      }
    });
    expect(data).toEqual({ value: 'ok' });
    expect(body).toEqual({
      reference: 'order-1',
      scheduledFor: '2026-05-01T09:00:00.000Z',
      priority: '9007199254740993'
    });
  });

  it('encodes path AND body simultaneously for multi-slot routes', async () => {
    // updateOrder has both `path: OrderIdPathParams` (Int64Codec) and
    // `body: UpdateOrderRequest` (IsoDateCodec + Int64Codec). The
    // wrapper merges encoded slots from the transformer with options;
    // both end up wire-shaped at the SDK function boundary.
    let url: string | undefined;
    let body: unknown;
    server.use(
      http.put(`${BASE_URL}/fixtures/orders/:orderId`, async ({ request }) => {
        url = request.url;
        body = await request.json();
        return HttpResponse.json({ value: 'ok' });
      })
    );

    const { data } = await updateOrder({
      path: { orderId: 9007199254740993n },
      body: {
        scheduledFor: new Date('2026-05-01T09:00:00.000Z'),
        priority: 42n
      }
    });
    expect(data).toEqual({ value: 'ok' });
    expect(url).toContain('/fixtures/orders/9007199254740993');
    expect(body).toEqual({
      scheduledFor: '2026-05-01T09:00:00.000Z',
      priority: '42'
    });
  });

  it('accepts a no-arg call for routes whose only registered slot is an optional body', async () => {
    // submitForReview's body schema has all-optional fields AND the
    // route doesn't set `required: true`, so the body slot is optional
    // and the wrapper is `(options?:)`. Caller can omit everything.
    let body: unknown = 'not-called';
    server.use(
      http.post(`${BASE_URL}/fixtures/reviews`, async ({ request }) => {
        // Bun/undici parses missing body as undefined; we want to assert
        // the request reached the handler at all.
        try {
          body = await request.json();
        } catch {
          body = undefined;
        }
        return HttpResponse.json({ value: 'ok' });
      })
    );

    const { data, error } = await submitForReview();
    expect(error).toBeUndefined();
    expect(data).toEqual({ value: 'ok' });
    // No body sent (or empty body) — the request is well-formed.
    expect(body).toBeFalsy();
  });

  it('rejects via z.encode when the caller passes a value the codec refuses', async () => {
    // `Int64Codec.encode(b) = b.toString()` — it accepts any bigint. To
    // force a rejection we pass a primitive that the runtime schema
    // rejects: `z.encode(IsoDateCodec, 'not a date')` throws because the
    // input doesn't match the runtime side (a Date instance).
    let hit = false;
    server.use(
      http.get(`${BASE_URL}/fixtures/events`, () => {
        hit = true;
        return HttpResponse.json({ value: 'should not run' });
      })
    );

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listRecentEvents({ query: { since: 'not-a-date' as any } })
    ).rejects.toThrow();
    expect(hit).toBe(false);
  });
});

describe('error response codec decoding via the SDK wrapper', () => {
  // The raw SDK function (in `sdk.gen.ts`) never runs a transformer on
  // error responses — `client-fetch` only invokes responseTransformer on
  // 2xx bodies. Without intervention, callers reading `result.error`
  // would see wire-shape values while the type system promised the codec
  // runtime shape. The wrapper closes that gap by calling
  // `${opId}ErrorTransformer` on the error path. These tests exercise
  // the wrapper directly to verify the runtime now matches the types.

  it('decodes throwOnError: false `result.error` through the registered schema (codec field round-trip)', async () => {
    // ServerError carries `traceId: Int64Codec` (wire string → runtime
    // bigint). The wrapper must run parseAsync so the caller reads the
    // bigint that the type promises.
    server.use(
      http.post(`${BASE_URL}/fixtures/createOrFetch`, () =>
        HttpResponse.json(
          { code: 'internal_error', message: 'kaboom', traceId: '999999999999' },
          { status: 500 }
        )
      )
    );

    const { data, error } = await createOrFetchResourceWrapper();
    expect(data).toBeUndefined();
    expect(error).toBeDefined();
    if (error && 'traceId' in error) {
      expect(typeof error.traceId).toBe('bigint');
      expect(error.traceId).toBe(999999999999n);
    } else {
      throw new Error('expected ServerError branch with traceId');
    }
  });

  it('decodes thrown errors on the throwOnError: true path', async () => {
    // The SDK function throws the wire-shape body when throwOnError: true.
    // The wrapper catches, decodes via the error transformer, and
    // re-throws the typed shape so the caller's `catch` block sees the
    // codec runtime value.
    server.use(
      http.post(`${BASE_URL}/fixtures/createOrFetch`, () =>
        HttpResponse.json(
          { code: 'internal_error', message: 'kaboom', traceId: '42' },
          { status: 500 }
        )
      )
    );

    let caught: unknown;
    try {
      await createOrFetchResourceWrapper({ throwOnError: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    // `'traceId' in caught` narrows `caught` to a record carrying
    // `traceId: unknown` — enough for `expect(...).toBe(42n)` to
    // run identity comparison without a value-level cast. The
    // remaining `caught.traceId` is `unknown`; vitest's `toBe`
    // accepts `unknown`, so no cast is needed at the test boundary.
    if (caught && typeof caught === 'object' && 'traceId' in caught) {
      expect(caught.traceId).toBe(42n);
      expect(typeof caught.traceId).toBe('bigint');
    } else {
      throw new Error('expected typed ServerError with bigint traceId');
    }
  });

  it('wraps HTTP body that does not match the schema as UnknownError (throwOnError: false)', async () => {
    // Server returns a body that doesn't match any registered error
    // schema (no `code` field). The wrapper produces an UnknownError
    // with the ZodError as cause and the original wire body reachable
    // via cause.cause. Type contract: `result.error` is widened to
    // `${Op}Error | UnknownError | TransportError`, so the consumer
    // narrows via the `isUnknownError` type-predicate without losing
    // access to the typed-error case.
    server.use(
      http.post(`${BASE_URL}/fixtures/createOrFetch`, () =>
        HttpResponse.json({ unexpected: 'shape' }, { status: 500 })
      )
    );

    const { error } = await createOrFetchResourceWrapper();
    expect(error).toBeDefined();
    if (isUnknownError(error)) {
      // ZodError carries `.issues` — confirms parseAsync was attempted.
      expect(error.cause).toBeDefined();
      expect(Array.isArray(error.cause.issues)).toBe(true);
      // The original wire body sits on `.body` (not `.cause.cause`)
      // so the depth at which the body is reachable is symmetric with
      // `transportError.cause` — both one hop from the wrapper-error.
      expect(error.body).toEqual({ unexpected: 'shape' });
    } else {
      throw new Error('expected UnknownError');
    }
  });

  it('throws UnknownError when HTTP body does not match the schema (throwOnError: true)', async () => {
    // Same malformed-body scenario but throwOnError: true. The
    // thrown value carries the same shape as the throwOnError: false
    // result.error: type-predicate narrowing, ZodError on `.cause`,
    // original wire body on `.body`.
    server.use(
      http.post(`${BASE_URL}/fixtures/createOrFetch`, () =>
        HttpResponse.json({ unexpected: 'shape' }, { status: 500 })
      )
    );

    let caught: unknown;
    try {
      await createOrFetchResourceWrapper({ throwOnError: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    if (isUnknownError(caught)) {
      expect(caught.body).toEqual({ unexpected: 'shape' });
    } else {
      throw new Error('expected UnknownError');
    }
  });

  it('wraps fetch-layer errors as TransportError without running parseAsync', async () => {
    // Simulate a transport failure by aborting the request mid-flight.
    // hey-api/client-fetch surfaces the AbortError as a thrown native
    // Error; the wrapper discriminates via `err instanceof Error` and
    // wraps as TransportError without attempting to validate against
    // the schema. The original native error is reachable via `.cause`.
    server.use(
      http.post(`${BASE_URL}/fixtures/createOrFetch`, async () => {
        // Hold the request indefinitely so the abort fires first.
        await new Promise(() => {});
        return HttpResponse.json({});
      })
    );

    const ac = new AbortController();
    queueMicrotask(() => ac.abort());

    let caught: unknown;
    try {
      await createOrFetchResourceWrapper({ throwOnError: true, signal: ac.signal });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    if (isTransportError(caught)) {
      expect(caught.cause).toBeInstanceOf(Error);
    } else {
      throw new Error(`expected TransportError, got ${JSON.stringify(caught)}`);
    }
  });

  it('decodes errors-only operation result.error', async () => {
    // `getErrorsOnly` has no 2xx — the wrapper still has full error
    // decoding because all the schemas are registered. The codec field
    // (`traceId` on ServerError) round-trips on the only path that
    // exists for this op.
    server.use(
      http.get(`${BASE_URL}/fixtures/errorsOnly`, () =>
        HttpResponse.json({ code: 'internal_error', message: 'no', traceId: '7' }, { status: 500 })
      )
    );

    const { error } = await getErrorsOnlyWrapper();
    expect(error).toBeDefined();
    if (error && 'traceId' in error) {
      expect(typeof error.traceId).toBe('bigint');
      expect(error.traceId).toBe(7n);
    } else {
      throw new Error('expected ServerError branch with bigint traceId');
    }
  });
});

describe('TanStack Query factory queryKey + async codecs', () => {
  // The queryKey factory body runs `z.encode(Schema, options.<slot>)`
  // synchronously — TanStack's queryKey getter can't be async (the
  // QueryClient hashes the key the moment a hook subscribes). For the
  // codecs the team ships today (Int64Codec, IsoDateCodec,
  // DecimalStringCodec, BigIntegerCodec) the encode side is sync, so
  // this is correct.
  //
  // For an *async* codec — one whose encode side returns a Promise via
  // an async refine/transform — `z.encode` throws a `$ZodAsyncError` at
  // call time rather than silently returning a Promise that ends up in
  // the queryKey. This test pins that assumption: if zod ever changes
  // `encode` to silently fall through to the async path, our queryKey
  // would carry `Promise<…>` values, JSON.stringify would render them
  // as `{}`, and every distinct codec input would collide on the same
  // hash. The thrown ZodAsyncError surfaces the limit clearly.
  it('z.encode throws ZodAsyncError on async-codec input — keeps queryKey hash-safe', async () => {
    const { z } = await import('./fixtures/zod.ts');
    const asyncBigIntCodec = z.codec(z.string().regex(/^\d+$/), z.bigint(), {
      decode: async (s: string) => BigInt(s),
      encode: async (b: bigint) => b.toString()
    });
    expect(() => z.encode(asyncBigIntCodec, 42n)).toThrow();
  });
});

describe('TanStack Query factory output (codec round-trip)', () => {
  it('encodes codec slots into queryKey[0] so JSON.stringify is hash-safe', () => {
    // The factory's queryKey carries wire-shape values for codec slots —
    // critical because tanstack's default `queryKeyHashFn` runs
    // JSON.stringify, which throws on bigint and renders Date as the
    // locale string (collides for two distinct timestamps in the same
    // minute on the runtime's local clock). Pre-encoding to the wire
    // shape sidesteps both issues without forcing the consumer to
    // configure `queryKeyHashFn` per QueryClient.
    const key = lookupBlockQueryKey({ path: { blockNumber: 9007199254740993n } });
    // queryKey is a one-tuple. Slot is post-encode.
    expect(key).toHaveLength(1);
    expect(key[0]).toMatchObject({
      _id: 'lookupBlock',
      path: { blockNumber: '9007199254740993' }
    });
    // Round-trip through the default hash to prove no bigint leaks through.
    expect(() => JSON.stringify(key)).not.toThrow();
  });

  it('queryFn calls the raw SDK with wire-shape slots and returns the parsed body', async () => {
    // Drive the factory the way useQuery would: invoke the queryFn with
    // the queryKey it built. The queryFn must reach the SDK with the
    // already-encoded wire shape (not the codec runtime shape) and
    // return the parsed response body.
    let url: string | undefined;
    server.use(
      http.get(`${BASE_URL}/fixtures/blocks/:blockNumber`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({ value: 'ok' });
      })
    );

    const opts = lookupBlockOptions({ path: { blockNumber: 9007199254740993n } });
    // queryFn signature is QueryFunction<TData, TQueryKey> from tanstack —
    // we don't import the type to avoid pulling tanstack into the test
    // (the runtime call only needs queryKey and signal).
    const ctx = {
      queryKey: opts.queryKey,
      signal: new AbortController().signal,
      // tanstack's QueryFunctionContext also has `client` and `meta`; both
      // unused by the generated queryFn body, so passing undefined-y
      // values keeps the runtime happy.
      client: undefined as never,
      meta: undefined
    };

    const data = await opts.queryFn!(ctx);
    expect(data).toEqual({ value: 'ok' });
    expect(url).toContain('/fixtures/blocks/9007199254740993');
  });

  it('encodes Date body fields into the queryKey, not the locale string', async () => {
    // The codec-on-body case is the harder one — JSON.stringify renders
    // a Date instance as ISO 8601 (which would happen to work), but the
    // factory needs to produce the same wire shape the SDK request
    // serialiser uses. Verify the queryKey carries the ISO string the
    // server expects.
    const opts = createOrderOptions({
      body: {
        reference: 'order-1',
        scheduledFor: new Date('2026-05-01T09:00:00.000Z'),
        priority: 9007199254740993n
      }
    });
    expect(opts.queryKey[0]).toMatchObject({
      _id: 'createOrder',
      body: {
        reference: 'order-1',
        scheduledFor: '2026-05-01T09:00:00.000Z',
        priority: '9007199254740993'
      }
    });
  });
});
