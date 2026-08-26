// Exhaustive error-handling tests for the codec-aware SDK wrapper.
//
// The earlier coverage was thin: each error category was tested against
// only one `throwOnError` mode, and string-emit assertions in
// runtime.test.ts were doing the work behavioural tests should be doing.
// This file pins every combination by:
//
//   - Three real failure scenarios that each map cleanly to one wrapper
//     category — `TransportError` (request never reached the API),
//     `ResponseValidationError` (response body didn't match any registered schema),
//     and typed `${Op}Error` (response body matched a registered schema).
//   - `describe.each` over `throwOnError: { false, true }` so every
//     scenario runs both ways. The wrapper has separate code paths for
//     each mode (catch+rethrow vs. mutate-result.error-in-place); only
//     covering one would mask regressions on the other.
//   - `fixtures/createOrFetchResource` (post `/fixtures/createOrFetch`)
//     as the canonical fixture: 200/201 success schemas + 400/404/500
//     error schemas including codec fields (`traceId: Int64Codec` on
//     ServerError), so the typed-error branch can also assert the
//     codec runtime shape rather than just "some error landed."
//   - `isTransportError` / `isResponseValidationError` / `isWrapperError` as the
//     consumer-facing narrowing API. No `instanceof`, no string-tag
//     comparisons — the predicates are what consumers actually call.
//
// A wrapper-emitted error carries no `as` cast at the assertion site:
// the type predicates narrow the `unknown` value to the right class,
// so `error.cause`, `error.body`, and `error.<typed-field>` resolve
// with no further casts. If a future refactor breaks that chain, this
// file fails at typecheck — which is the contract the wrapper's
// runtime/type alignment is supposed to deliver.

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  client,
  createOrFetchResource,
  getErrorsOnly,
  getScalarBigInt,
  isTransportError,
  isResponseValidationError,
  isWrapperError
} from './public-client.ts';

const BASE_URL = 'http://api.test';
const server = setupServer();

beforeAll(() => {
  client.setConfig({ baseUrl: BASE_URL });
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
  client.setConfig({ throwOnError: false, responseStyle: 'fields' });
});

afterAll(() => server.close());

// ── Test harnesses ────────────────────────────────────────────────────────────

// ── 1. TransportError (request never produces an HTTP response) ──────────────

describe('TransportError — request never reached the API', () => {
  // We trigger this via an AbortController: `fetch` rejects with an
  // AbortError, which extends the global `Error` constructor in our
  // realm. The wrapper's `err instanceof Error` discriminator catches
  // it and never runs `parseAsync` (there's no body to validate).

  describe.each([{ throwOnError: false }, { throwOnError: true }])(
    'throwOnError: $throwOnError',
    ({ throwOnError }) => {
      it('wraps the native abort error as TransportError', async () => {
        server.use(
          http.post(`${BASE_URL}/fixtures/createOrFetch`, async () => {
            await new Promise(() => {}); // hold forever; abort fires first
            return HttpResponse.json({});
          })
        );

        const ac = new AbortController();
        queueMicrotask(() => ac.abort());

        const surfaced = await captureSurfacedError(() =>
          createOrFetchResource({ throwOnError, signal: ac.signal })
        );

        if (!isTransportError(surfaced)) {
          throw new Error(`expected TransportError, got ${describeError(surfaced)}`);
        }
        // After narrowing: cause is an Error (no cast needed).
        expect(surfaced.cause).toBeInstanceOf(Error);
        expect(surfaced.message).toBe('Request failed before producing an HTTP response');
        // The marker key matches the canonical Symbol.for(...) — same
        // anchor used by the type guard. Worth pinning so a rename
        // would surface here instead of as a silent class-identity
        // bug across realms. The class type doesn't declare a symbol
        // index signature (the cast at construction site widens
        // through `unknown`), so we mirror the same widening here.
        const surfacedAsRecord = surfaced as unknown as Record<symbol, unknown>;
        expect(
          surfacedAsRecord[Symbol.for('@polygonlabs/zod-to-openapi-heyapi/is-transport-error')]
        ).toBe(true);
        // isWrapperError is the union "any wrapper-emitted" guard.
        expect(isWrapperError(surfaced)).toBe(true);
      });
    }
  );
});

// ── 2. ResponseValidationError (response body didn't match any registered schema) ───────

describe('ResponseValidationError — schema mismatch on the error body', () => {
  // Server replies with a body that doesn't match any of the
  // registered error schemas (no `code` field, no `traceId`,
  // unrecognised structure). The wrapper runs `parseAsync` against the
  // union of registered error schemas, gets a ZodError, and wraps it
  // as ResponseValidationError carrying both the parse issues (on `.cause`) and
  // the original wire body (on `.body`).

  const badBody = { unexpected: 'shape', value: 42 };

  describe.each([{ throwOnError: false }, { throwOnError: true }])(
    'throwOnError: $throwOnError',
    ({ throwOnError }) => {
      it('wraps the malformed body as ResponseValidationError with cause + body', async () => {
        server.use(
          http.post(`${BASE_URL}/fixtures/createOrFetch`, () =>
            HttpResponse.json(badBody, { status: 500 })
          )
        );

        const surfaced = await captureSurfacedError(() => createOrFetchResource({ throwOnError }));

        if (!isResponseValidationError(surfaced)) {
          throw new Error(`expected ResponseValidationError, got ${describeError(surfaced)}`);
        }
        // ZodError carries `.issues` — confirms parseAsync actually ran.
        expect(Array.isArray(surfaced.cause.issues)).toBe(true);
        expect(surfaced.cause.issues.length).toBeGreaterThan(0);
        // Wire body sits on `.body` (one hop, symmetric with
        // transportError.cause).
        expect(surfaced.body).toEqual(badBody);
        // Same union-guard contract.
        expect(isWrapperError(surfaced)).toBe(true);
        // Exclusivity: an ResponseValidationError must not also report as
        // TransportError. This is the core discriminator contract —
        // a regression in the marker assignment would break it.
        expect(isTransportError(surfaced)).toBe(false);
      });

      it('also fires on errors-only operations (no 2xx schema registered)', async () => {
        // `getErrorsOnly` has no success branch, but the wrapper still
        // owns the error transformer because error schemas are
        // registered. Schema-mismatch behaviour must be identical.
        server.use(
          http.get(`${BASE_URL}/fixtures/errorsOnly`, () =>
            HttpResponse.json(badBody, { status: 500 })
          )
        );

        const surfaced = await captureSurfacedError(() => getErrorsOnly({ throwOnError }));

        if (!isResponseValidationError(surfaced)) {
          throw new Error(`expected ResponseValidationError, got ${describeError(surfaced)}`);
        }
        expect(surfaced.body).toEqual(badBody);
      });
    }
  );
});

// ── 2b. ResponseValidationError (SUCCESS body failed response validation) ────

describe('ResponseValidationError — schema mismatch on a 2xx body', () => {
  // Regression pin: a 2xx body that fails the registered RESPONSE
  // schema used to surface as a TransportError — the response
  // transformer (run by client-fetch inside the awaited SDK call)
  // rejected with a bare ZodError, and the wrapper's generic
  // `instanceof Error` catch re-wrapped it as a transport failure.
  // A schema-violating success body is the single most important
  // thing this client detects (it's how a producer's contract drift —
  // e.g. a documented-string field shipping as a bare number — stays
  // undeliverable instead of silently corrupting), so it must be
  // reported as what it is: a ResponseValidationError carrying the
  // parse issues and the offending (post-JSON.parse) body.

  const badSuccessBody = { id: 42 }; // ResourceFetched wants id: string + data: string

  describe.each([{ throwOnError: false }, { throwOnError: true }])(
    'throwOnError: $throwOnError',
    ({ throwOnError }) => {
      it('wraps the invalid 200 body as ResponseValidationError, not TransportError', async () => {
        server.use(
          http.post(`${BASE_URL}/fixtures/createOrFetch`, () =>
            HttpResponse.json(badSuccessBody, { status: 200 })
          )
        );

        const surfaced = await captureSurfacedError(() => createOrFetchResource({ throwOnError }));

        if (!isResponseValidationError(surfaced)) {
          throw new Error(`expected ResponseValidationError, got ${describeError(surfaced)}`);
        }
        // The exact regression: this used to narrow as TransportError.
        expect(isTransportError(surfaced)).toBe(false);
        expect(isWrapperError(surfaced)).toBe(true);
        // parseAsync ran against the response schema union and the
        // issues describe the success-schema mismatch.
        expect(Array.isArray(surfaced.cause.issues)).toBe(true);
        expect(surfaced.cause.issues.length).toBeGreaterThan(0);
        // The body that failed validation rides on `.body` — same
        // one-hop contract as the error-status flavour.
        expect(surfaced.body).toEqual(badSuccessBody);
      });

      it('also fires on pass-through ops (no error schemas, no input slots)', async () => {
        // `getScalarBigInt` emits the minimal pass-through wrapper —
        // no try/catch of its own — so the classification must come
        // from the response transformer itself throwing the
        // ResponseValidationError. This pins the fix at its source
        // rather than relying on the full wrapper's pass-through
        // branches.
        server.use(
          http.get(`${BASE_URL}/fixtures/getScalarBigInt`, () =>
            HttpResponse.json({ value: 42 }, { status: 200 })
          )
        );

        const surfaced = await captureSurfacedError(() => getScalarBigInt({ throwOnError }));

        if (!isResponseValidationError(surfaced)) {
          throw new Error(`expected ResponseValidationError, got ${describeError(surfaced)}`);
        }
        expect(isTransportError(surfaced)).toBe(false);
        expect(surfaced.body).toEqual({ value: 42 });
      });
    }
  );
});

// ── 3. Typed ${Op}Error (response body matched a registered schema) ─────────

describe('Typed `${Op}Error` — response body matched a registered schema', () => {
  // The wrapper's job here is the codec round-trip on the error path:
  // the SDK doesn't run a transformer on non-2xx bodies (client-fetch
  // limitation), so without the wrapper a `traceId: Int64Codec` field
  // would arrive as a wire `string` even though the type promised
  // `bigint`. The wrapper decodes through the union of error schemas
  // and surfaces the typed runtime shape.

  describe.each([{ throwOnError: false }, { throwOnError: true }])(
    'throwOnError: $throwOnError',
    ({ throwOnError }) => {
      it('decodes the typed-error codec field (traceId Int64Codec → bigint)', async () => {
        server.use(
          http.post(`${BASE_URL}/fixtures/createOrFetch`, () =>
            HttpResponse.json(
              {
                code: 'internal_error',
                message: 'kaboom',
                traceId: '999999999999'
              },
              { status: 500 }
            )
          )
        );

        const surfaced = await captureSurfacedError(() => createOrFetchResource({ throwOnError }));

        // Typed-error branch: NOT a wrapper-error. The wrapper-error
        // guards return false; the value is the codec-decoded
        // `${Op}Error` union.
        expect(isWrapperError(surfaced)).toBe(false);
        expect(isTransportError(surfaced)).toBe(false);
        expect(isResponseValidationError(surfaced)).toBe(false);

        // Narrow to the ServerError branch. After `'traceId' in error`
        // the union narrows; no `as` cast needed.
        if (surfaced && typeof surfaced === 'object' && 'traceId' in surfaced) {
          // The codec promise: traceId is bigint at runtime, not the
          // wire `string`. This is the test that proves error-side
          // codecs round-trip end-to-end.
          expect(typeof surfaced.traceId).toBe('bigint');
          expect(surfaced.traceId).toBe(999999999999n);
        } else {
          throw new Error(`expected ServerError branch, got ${describeError(surfaced)}`);
        }
      });

      it('passes through 4xx typed errors (no codec field) unchanged', async () => {
        // `BadRequestError` has only string fields — exercises the
        // typed-error path without codec involvement. Runtime should
        // be a plain object with `code` / `message` / `fieldErrors`.
        server.use(
          http.post(`${BASE_URL}/fixtures/createOrFetch`, () =>
            HttpResponse.json(
              {
                code: 'bad_request',
                message: 'missing id',
                fieldErrors: { id: 'required' }
              },
              { status: 400 }
            )
          )
        );

        const surfaced = await captureSurfacedError(() => createOrFetchResource({ throwOnError }));

        expect(isWrapperError(surfaced)).toBe(false);
        expect(surfaced).toMatchObject({
          code: 'bad_request',
          message: 'missing id',
          fieldErrors: { id: 'required' }
        });
      });

      it('also surfaces 404 NotFoundError as a typed error', async () => {
        // Multi-status error union — every registered code must reach
        // the consumer as the typed shape, not just the codec-bearing
        // one. The wrapper's union parse covers all three (400/404/500).
        // NotFoundError schema: { code: 'not_found', message, resourceId }.
        server.use(
          http.post(`${BASE_URL}/fixtures/createOrFetch`, () =>
            HttpResponse.json(
              {
                code: 'not_found',
                message: 'no such resource',
                resourceId: 'order_123'
              },
              { status: 404 }
            )
          )
        );

        const surfaced = await captureSurfacedError(() => createOrFetchResource({ throwOnError }));

        expect(isWrapperError(surfaced)).toBe(false);
        if (
          surfaced &&
          typeof surfaced === 'object' &&
          'code' in surfaced &&
          surfaced.code === 'not_found'
        ) {
          // Narrow worked — surfaced is the typed NotFoundError shape.
          // No further cast needed for the assertion.
          expect(surfaced).toMatchObject({
            code: 'not_found',
            message: 'no such resource',
            resourceId: 'order_123'
          });
        } else {
          throw new Error(`expected NotFoundError branch, got ${describeError(surfaced)}`);
        }
      });
    }
  );
});

// ── 5. responseStyle: 'data' runtime parity ─────────────────────────────────
//
// The wrapper's emitted `WrapErrors<TData, TError, ThrowOnError,
// TResponseStyle>` type threads a fourth generic that conditionally
// produces hey-api's 'fields' or 'data' return shape. These tests
// prove the runtime matches the static contract — the wrapper must
// not mutate `result.error` on a 'data'-style return (which has no
// error field), and the throw-mode wrapping still fires for both
// transport and validation failures.

describe("responseStyle: 'data' runtime — wrapper stays consistent with hey-api", () => {
  describe('throwOnError: false', () => {
    afterEach(() => client.setConfig({ responseStyle: 'fields' }));

    it('returns the flat data on success (no { data, error, request, response } envelope)', async () => {
      // The 'data' style behaviour is gated on the client config; the
      // wrapper just threads the call through. Per-call generic pins
      // the static return shape so `result` is typed as
      // `CreateOrFetchResourceResponse | undefined`.
      client.setConfig({ responseStyle: 'data' });
      server.use(
        http.post(`${BASE_URL}/fixtures/createOrFetch`, () =>
          HttpResponse.json({ id: 'res_42', data: 'flat-shape' }, { status: 200 })
        )
      );
      const result = await createOrFetchResource<false, 'data'>();
      // Bare value — not the {data,error,request,response} envelope.
      expect(result).toEqual({ id: 'res_42', data: 'flat-shape' });
    });

    it("returns undefined on the error path (hey-api's 'data' mode swallows errors)", async () => {
      // In 'data' + throwOnError: false, hey-api's runtime drops the
      // error body entirely and returns undefined. The wrapper has
      // nothing to wrap — and importantly must NOT misinterpret an
      // object result as an error envelope.
      client.setConfig({ responseStyle: 'data' });
      server.use(
        http.post(`${BASE_URL}/fixtures/createOrFetch`, () =>
          HttpResponse.json({ code: 'bad_request', message: 'no' }, { status: 400 })
        )
      );
      const result = await createOrFetchResource<false, 'data'>();
      expect(result).toBeUndefined();
    });

    it("doesn't wrap a successful 'data'-style result into a TransportError / ResponseValidationError", async () => {
      // Discriminator sanity check: in 'data' mode hey-api strips the
      // `{ data, error, request, response }` envelope, so the
      // wrapper's `'request' in result && 'response' in result` gate
      // must NOT fire even for object-valued success payloads. If it
      // did, the wrapper would attempt to wrap a non-error value as
      // ResponseValidationError and surface that to the caller.
      client.setConfig({ responseStyle: 'data' });
      server.use(
        http.post(`${BASE_URL}/fixtures/createOrFetch`, () =>
          HttpResponse.json({ id: 'r', data: 'ok' }, { status: 200 })
        )
      );
      const result = await createOrFetchResource<false, 'data'>();
      // The result is the success payload itself, not an envelope.
      expect(result).toEqual({ id: 'r', data: 'ok' });
      // And it's definitely not a wrapper-emitted error.
      expect(isWrapperError(result)).toBe(false);
      expect(isTransportError(result)).toBe(false);
      expect(isResponseValidationError(result)).toBe(false);
    });
  });

  describe('throwOnError: true', () => {
    afterEach(() => client.setConfig({ responseStyle: 'fields', throwOnError: false }));

    it('returns the flat data on success', async () => {
      client.setConfig({ responseStyle: 'data', throwOnError: true });
      server.use(
        http.post(`${BASE_URL}/fixtures/createOrFetch`, () =>
          HttpResponse.json({ id: 'r', data: 'ok' }, { status: 200 })
        )
      );
      const data = await createOrFetchResource<true, 'data'>();
      expect(data).toEqual({ id: 'r', data: 'ok' });
    });

    it('throws a TransportError on fetch failure (request never reached the API)', async () => {
      client.setConfig({ responseStyle: 'data', throwOnError: true });
      const controller = new AbortController();
      controller.abort();
      let caught: unknown;
      try {
        await createOrFetchResource<true, 'data'>({ signal: controller.signal });
      } catch (err) {
        caught = err;
      }
      if (!isTransportError(caught)) {
        throw new Error(`expected TransportError, got ${describeError(caught)}`);
      }
      expect(caught.cause).toBeInstanceOf(Error);
    });

    it('throws a ResponseValidationError when the wire body fails parseAsync', async () => {
      // 500 with a body that doesn't match the ServerError schema.
      // The wrapper's catch block runs the error transformer and
      // wraps the validation failure — same wrapping logic as in
      // 'fields' mode.
      client.setConfig({ responseStyle: 'data', throwOnError: true });
      server.use(
        http.post(`${BASE_URL}/fixtures/createOrFetch`, () =>
          HttpResponse.json({ unexpected: 'shape', value: 42 }, { status: 500 })
        )
      );
      let caught: unknown;
      try {
        await createOrFetchResource<true, 'data'>();
      } catch (err) {
        caught = err;
      }
      if (!isResponseValidationError(caught)) {
        throw new Error(`expected ResponseValidationError, got ${describeError(caught)}`);
      }
      // Cross-realm-safe narrowing — same predicate works in both styles.
      expect(caught.body).toEqual({ unexpected: 'shape', value: 42 });
      expect(caught.cause.issues.length).toBeGreaterThan(0);
    });

    it('throws a typed ${Op}Error when the wire body matches a registered error schema (codec round-trip)', async () => {
      // 500 with a body that DOES match ServerError. The wrapper's
      // catch block runs the transformer successfully and throws the
      // typed (codec-decoded) error.
      client.setConfig({ responseStyle: 'data', throwOnError: true });
      server.use(
        http.post(`${BASE_URL}/fixtures/createOrFetch`, () =>
          HttpResponse.json(
            { code: 'internal_error', message: 'kaboom', traceId: '987654321' },
            { status: 500 }
          )
        )
      );
      let caught: unknown;
      try {
        await createOrFetchResource<true, 'data'>();
      } catch (err) {
        caught = err;
      }
      // Typed `${Op}Error`, not a wrapper error.
      expect(isWrapperError(caught)).toBe(false);
      if (caught && typeof caught === 'object' && 'traceId' in caught) {
        // Codec round-trip on the error path: wire `'987654321'` → bigint.
        expect(typeof caught.traceId).toBe('bigint');
        expect(caught.traceId).toBe(987654321n);
      } else {
        throw new Error(`expected typed ServerError shape, got ${describeError(caught)}`);
      }
    });
  });
});

// ── 4. Mutual exclusion across categories ────────────────────────────────────

describe('discriminator exclusivity', () => {
  // Sanity test for the symbol-based marker contract: the same value
  // cannot pass two of the three category guards. The earlier
  // `_tag`-string discriminator could in principle have collided
  // (consumer-thrown TransportError lookalike); the symbol keys —
  // `Symbol.for(@polygonlabs/...)` — are anchored in the global
  // registry so they identify uniquely.
  it('a fresh plain object passes none of the guards', () => {
    const noise = { code: 'whatever', not: 'an error class' };
    expect(isTransportError(noise)).toBe(false);
    expect(isResponseValidationError(noise)).toBe(false);
    expect(isWrapperError(noise)).toBe(false);
  });

  it('null and undefined fail all guards without throwing', () => {
    for (const v of [null, undefined, 0, '', false]) {
      expect(isTransportError(v)).toBe(false);
      expect(isResponseValidationError(v)).toBe(false);
      expect(isWrapperError(v)).toBe(false);
    }
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Runs the given operation and returns whatever surfaced as the error,
 * regardless of `throwOnError` mode. Equivalent to:
 *
 *   const surfaced = throwOnError
 *     ? await catch(() => op())
 *     : (await op()).error;
 *
 * Centralised so each scenario describes the failure once and lets
 * the harness handle the branching. Param typed as `Promise<unknown>`
 * because each wrapper's return type differs by op + ThrowOnError —
 * threading those generics through the helper would force every
 * caller to specify them. We extract `.error` defensively (any value
 * with that field).
 */
async function captureSurfacedError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    const r = await run();
    if (r && typeof r === 'object' && 'error' in r) {
      return r.error;
    }
    return undefined;
  } catch (err) {
    return err;
  }
}

/** Pretty-print an unknown error for assertion failures. */
function describeError(v: unknown): string {
  if (v instanceof Error) return `${v.constructor.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
