// Codecs for the wire formats JSON-on-the-wire services keep reinventing.
//
// JSON has no native int64, no native big integer, no precision-preserving
// decimal, and no native Date — so services serialise these as strings.
// `z.codec(input, output, { decode, encode })` lets us declare the wire shape
// and the runtime shape together: the input schema validates the string on
// the way in, decode produces the runtime value, the output schema validates
// the runtime value, and encode is used by `z.encode()` to re-emit the wire
// form (round-trip from the runtime side).
//
// Each codec deliberately ships *without* `.openapi()` metadata baked in.
// Description and `x-go-type` style hints are caller-specific; chain
// `.openapi(...)` at the registration site.

import { z } from 'zod';

const digitString = /^-?\d+$/;
const decimalNumber = /^-?\d+(\.\d+)?$/;

/**
 * Wire: signed-integer string. Runtime: `bigint` constrained to int64 range
 * (`-(2^63)` … `2^63 - 1`).
 *
 * Use this for any integer that may exceed `Number.MAX_SAFE_INTEGER`
 * (`2^53 - 1`) but is known to fit in a 64-bit signed slot — block heights,
 * monotonic IDs, sequence numbers, fixed-width on-chain counters, anything
 * the backend stores as `bigint`/`int8`/`BIGINT`. Decoding rejects values
 * outside the int64 range; reach for {@link BigIntegerCodec} when an unbounded
 * value is required (crypto wei amounts, balances).
 *
 * Note that `JSON.stringify(bigint)` throws — encoding a runtime value via
 * `z.encode()` returns the wire string, which is the right shape for any
 * subsequent JSON serialiser.
 */
export const Int64Codec = z.codec(z.string().regex(digitString), z.int64(), {
  decode: (s) => BigInt(s),
  encode: (b) => b.toString()
});

/**
 * Wire: signed-integer string. Runtime: unbounded `bigint`.
 *
 * Use this for integers that can exceed int64 — wei-denominated token
 * amounts, raw uint256 values from EVM contracts, anything cryptographic.
 * If a value is known to fit in 64 bits, prefer {@link Int64Codec} so
 * out-of-range inputs fail at parse time rather than silently widening.
 */
export const BigIntegerCodec = z.codec(z.string().regex(digitString), z.bigint(), {
  decode: (s) => BigInt(s),
  encode: (b) => b.toString()
});

/**
 * Wire: decimal-number string. Runtime: the same string, validated.
 *
 * JSON's `number` is IEEE-754 double; many financial and on-chain quantities
 * (rates, percentages, token amounts denominated in human units) lose
 * precision when round-tripped through it. Keeping the wire string as the
 * runtime value defers the choice of decimal library to the consumer
 * (`decimal.js`, `bignumber.js`, `dnum`, raw arithmetic) — this codec only
 * guarantees the shape on the way in.
 *
 * Accepted: optional sign, one or more digits, optional fractional part with
 * one or more digits. Rejected: scientific notation, leading `.`, trailing
 * `.`, empty string, non-digit characters.
 */
export const DecimalStringCodec = z.codec(z.string().regex(decimalNumber), z.string(), {
  decode: (s) => s,
  encode: (s) => s
});

/**
 * Wire: ISO-8601 datetime string. Runtime: `Date`.
 *
 * Bare `z.date()` doesn't make sense on the JSON wire — `Date` instances
 * survive `JSON.parse` only as strings, and consumers always have to decode
 * them back. This codec captures that decode + encode pair once.
 *
 * Input is validated by `z.iso.datetime()`, so non-ISO strings are rejected
 * before `new Date(...)` is ever called.
 */
export const IsoDateCodec = z.codec(z.iso.datetime(), z.date(), {
  decode: (s) => new Date(s),
  encode: (d) => d.toISOString()
});
