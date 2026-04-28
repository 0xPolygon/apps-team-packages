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
