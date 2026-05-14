// Test-only re-exports of internal codegen artifacts.
//
// This file is NOT a model for consumer code — it is the opposite of
// `public-client.ts`. It exposes pieces of the codegen tree that are
// deliberately kept off the public surface (`@hey-api/sdk` runs with
// `includeInEntry: false` so the raw, non-codec-wrapped SDK functions
// don't leak into the consumer API).
//
// We reach in here only because the type-parity assertions in
// `types.test.ts` need both halves of the comparison: the wrapper's
// return type AND the raw SDK function's return type. The contract
// the test pins — pass-through wrappers (no declared error responses)
// return exactly what the raw SDK function returns; error-widening
// wrappers leave `['data']` unchanged from the raw SDK and only widen
// `['error']` — only has meaning if we can name both sides.
//
// Underscore prefix and the `_TestInternal_` symbol prefix mark this
// boundary so any consumer who finds this file via grep can tell at a
// glance that these symbols are not part of `@polygonlabs/zod-to-openapi-heyapi`'s
// public API.

export {
  createOrder as _TestInternal_createOrderSdk,
  createOrFetchResource as _TestInternal_createOrFetchResourceSdk,
  getCodecObject as _TestInternal_getCodecObjectSdk,
  getErrorsOnly as _TestInternal_getErrorsOnlySdk,
  lookupBlock as _TestInternal_lookupBlockSdk
} from './__generated__/sdk.gen.ts';
