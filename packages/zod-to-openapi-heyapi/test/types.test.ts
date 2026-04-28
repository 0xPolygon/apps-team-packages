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
  CreateOrFetchResourceError,
  CreateOrFetchResourceErrors,
  CreateOrFetchResourceResponse,
  CreateOrFetchResourceResponses,
  GetCodecObjectResponse,
  GetCodecObjectResponses,
  GetDateFieldResponse
} from './__generated__/registry-validator.gen.ts';
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
  >
];

const _assertions: Assertions | undefined = undefined;
void _assertions;

describe('generated types are z.output<typeof Schema>', () => {
  it('compiles', () => {
    // Compile-time assertions above are the actual test.
  });
});
