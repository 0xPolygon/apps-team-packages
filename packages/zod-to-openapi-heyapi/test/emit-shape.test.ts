// Negative-emit and structural-invariant tests on the generated client.
//
// Replaces the much-larger string-emit suite that came before. Most
// of the textual assertions there were proxies for runtime behaviour
// that's now exercised end-to-end by `api.test.ts` (success paths),
// `api-errors.test.ts` (the three error categories × throwOnError),
// `hooks.browser.test.tsx` (real-browser hook integration), and the
// type-level smoke tests in `types.test.ts`. Whatever those suites
// can prove, the regex tests can't prove better — and the regexes
// over-specify, breaking on cosmetic emit changes that don't change
// behaviour.
//
// What survives here is the irreducible kernel: things that aren't
// observable from a passing behaviour test, namely
//
//   - **Negative-emit checks** ("we DON'T emit X under condition Y").
//     If we accidentally start emitting an artifact we shouldn't,
//     consumer code will compile and run; only a structural check
//     here surfaces the leak.
//   - **Cross-file structural invariants** (upstream tanstack
//     factories live in `@tanstack/react-query.gen.ts`, ours in
//     `registry-validator.gen.ts`; the QueryKey type / createQueryKey
//     util emit exactly once even though many factories share them).
//   - **Audit-gate behaviour** for parameter-only schemas — proving
//     we don't try to import a Zod export that doesn't exist on the
//     consumer's `schemasFrom` package, regardless of which
//     downstream operation triggers the gate.
//
// If you're adding a test that asserts on what the emit looks like,
// ask first whether a behaviour test would prove the same thing.
// If yes, the behaviour test belongs in `api.test.ts` /
// `api-errors.test.ts` / `hooks.browser.test.tsx`, not here.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { generatedDir } from './setup.ts';

const generatedFile = resolve(generatedDir, 'registry-validator.gen.ts');

function readGenerated(): string {
  return readFileSync(generatedFile, 'utf8');
}

// ── Negative emit ───────────────────────────────────────────────────────────

describe('negative emit', () => {
  it('does not emit a Responses type or transformer for errors-only ops', () => {
    // `getErrorsOnly` has no 2xx response. There's nothing to
    // transform on the success side, so emitting either artifact
    // would produce dead code that consumers can import (and would
    // have to wonder about). Keep the wrapper / Errors aliases — those
    // ARE useful — but skip the Responses surface.
    const src = readGenerated();
    expect(src).not.toMatch(/export type GetErrorsOnlyResponses\b/);
    expect(src).not.toMatch(/export const getErrorsOnlyTransformer\b/);
  });

  it('does not emit input artifacts for ops with no registered input schema', () => {
    // `getItemWithRegisteredParam` declares its `params` as
    // `z.object({ itemId: ... })` — anonymous wrapper, no `.openapi(...)`
    // refId. The plugin only emits Input / inputTransformer / wrapper
    // when the slot's schema is itself a registered ZodObject. An
    // anonymous wrapper isn't reachable by name from `schemasFrom`, so
    // any emit referencing it would fail to compile in the consumer's
    // tree. The plugin must skip the input pipeline for this op
    // entirely.
    const src = readGenerated();
    expect(src).not.toMatch(/export type GetItemWithRegisteredParamInput\b/);
    expect(src).not.toMatch(/getItemWithRegisteredParamInputTransformer/);
  });

  it('does not emit anything for parameter-only schemas (audit gate)', () => {
    // The fixture registers `itemId` as a path parameter under a
    // deliberately lower-cased key. zod-to-openapi v8's
    // OpenApiGeneratorV3 lifts that into both
    // `components.parameters.itemId` AND `components.schemas.itemId`
    // (as a $ref target for the parameter object). A naive audit that
    // walks `components.schemas` and demands a Zod export under every
    // name would trip on this — the consumer's `schemasFrom` package
    // doesn't export `itemId`. The narrowed audit walks only response
    // `$ref`s, so this lift is a no-op for our codegen. Confirm
    // nothing related to it leaks into the generated client.
    const src = readGenerated();
    expect(src).not.toMatch(/import \{[^}]*\bitemId\b[^}]*\}/);
    expect(src).not.toMatch(/typeof itemId\b/);
    expect(src).not.toMatch(/\bitemId\.parseAsync/);
  });

  it('does not emit an ErrorTransformer for ops with no error schemas', () => {
    // Codec-input op `lookupBlock` has only a 200 response. Wrapper
    // path is the simple input-encoding form (no try/catch around the
    // SDK call); no error transformer to bind to. Same for the
    // baseline non-codec ops.
    const src = readGenerated();
    expect(src).not.toMatch(/lookupBlockErrorTransformer/);
    expect(src).not.toMatch(/getCodecObjectErrorTransformer/);
    expect(src).not.toMatch(/getScalarStringErrorTransformer/);
  });

  it('does not emit `2`-suffixed wire-shape duplicates of our type aliases in the public barrel', () => {
    // The typescript plugin runs alongside ours and emits its own
    // wire-shape `${Op}Error` / `${Op}Response` types into
    // `types.gen.ts`. Without `includeInEntry: false` on the
    // typescript plugin, the auto-barrel re-exports both ours and
    // theirs with collision-renamed `${Name}2` suffixes — a footgun
    // for consumers who reach for `CreateOrderError2` thinking it's a
    // v2 / alternate form and silently get the wire shape (string
    // instead of bigint, etc.). Keeping the suffix-2 names out of the
    // barrel is the only signal that the suppression is wired
    // correctly.
    const barrel = readFileSync(resolve(generatedDir, 'index.ts'), 'utf8');
    expect(barrel).not.toMatch(/\b\w+(?:Response|Responses|Error|Errors|Data)2\b/);
  });
});

// ── Single-emit invariants ──────────────────────────────────────────────────

describe('single-emit invariants', () => {
  it('emits the QueryKey type alias and createQueryKey utility exactly once', () => {
    // Every codec-aware factory shares both. The scaffold-on-first-use
    // hook is the only thing that prevents duplicate declarations
    // across many ops; if it ever breaks, TypeScript surfaces it as
    // a duplicate-export error. This test is the structural pin for
    // that guarantee.
    const src = readGenerated();
    const queryKeyTypeMatches =
      src.match(/export type QueryKey<TOptions extends Options> = \[/g) ?? [];
    expect(queryKeyTypeMatches).toHaveLength(1);
    const createQueryKeyMatches = src.match(/^const createQueryKey = </gm) ?? [];
    expect(createQueryKeyMatches).toHaveLength(1);
  });

  it('emits the wrapper-error scaffolding (classes + guards + WrapErrors alias) exactly once', () => {
    // Same lazy-scaffold contract for the wrapper-error surface: every
    // op that has a registered error schema triggers
    // `ensureWrapperErrorClasses`, but the actual emit must happen
    // once. Multiple `export class TransportError` declarations would
    // compile-error; the count assertion catches a regression where
    // the lazy guard breaks.
    const src = readGenerated();
    const transportClass = src.match(/^export class TransportError\b/gm) ?? [];
    expect(transportClass).toHaveLength(1);
    const unknownClass = src.match(/^export class ResponseValidationError\b/gm) ?? [];
    expect(unknownClass).toHaveLength(1);
    const isTransportFn = src.match(/^export const isTransportError = /gm) ?? [];
    expect(isTransportFn).toHaveLength(1);
    const wrapErrorsAlias = src.match(/^export type WrapErrors</gm) ?? [];
    expect(wrapErrorsAlias).toHaveLength(1);
  });

  it('does NOT emit wrapper-error scaffolding when no op has error schemas', () => {
    // The scaffolding emit is gated on at least one op having
    // declared error responses — the lazy hook only fires the first
    // time `errorTransformerSymbol` is non-empty. We can't directly
    // observe "no emit" against the live fixture (which DOES have
    // error schemas), but we CAN verify the gating works by checking
    // that ops without errors don't trigger it on their own:
    // `getCodecObject`'s wrapper is a thin pass-through that doesn't
    // reference any of the wrapper-error symbols. Sanity-check by
    // confirming the wrapper-error symbols aren't referenced in
    // pass-through wrapper bodies.
    const src = readGenerated();
    const passThroughMatch = src.match(
      /export const getCodecObject = async <ThrowOnError extends boolean = false>\([^)]*\) =>[^;]+;/
    );
    expect(passThroughMatch).not.toBeNull();
    if (passThroughMatch) {
      expect(passThroughMatch[0]).not.toMatch(/TransportError|ResponseValidationError|WrapErrors/);
    }
  });
});

// ── Cross-file structural invariants ────────────────────────────────────────

describe('cross-file emission split', () => {
  it('upstream tanstack emits factories for non-codec ops in @tanstack/react-query.gen.ts', () => {
    // The parser-level `isQuery` hook returns false for codec op ids,
    // letting the upstream `@tanstack/react-query` plugin handle every
    // non-codec op. This test pins the contract from the upstream
    // side: non-codec ops have a factory in the upstream file, and
    // codec ops don't (they're in our file). A regression that broke
    // either direction would produce a missing or duplicated factory
    // depending on the timing.
    const upstream = readFileSync(resolve(generatedDir, '@tanstack/react-query.gen.ts'), 'utf8');
    expect(upstream).toMatch(/export const getCodecObjectQueryKey\b/);
    expect(upstream).toMatch(/export const getScalarStringQueryKey\b/);
    expect(upstream).not.toMatch(/export const lookupBlockQueryKey\b/);
    expect(upstream).not.toMatch(/export const createOrderQueryKey\b/);
  });

  it('codec-aware factories live in registry-validator.gen.ts (not the upstream file)', () => {
    // Mirror of the above. Same gating, asserted from our side: the
    // codec-aware factories the upstream plugin DIDN'T emit are
    // exactly the ones we DID.
    const src = readGenerated();
    expect(src).toMatch(/export const lookupBlockQueryKey\b/);
    expect(src).toMatch(/export const createOrderQueryKey\b/);
    expect(src).not.toMatch(/export const getCodecObjectQueryKey\b/);
    expect(src).not.toMatch(/export const getScalarStringQueryKey\b/);
  });
});

// ── Runtime invariants on emitted code ──────────────────────────────────────

describe('runtime invariants on emitted code', () => {
  it('preserves the canonical operation name on the pass-through wrapper at runtime', async () => {
    // Pass-through wrapper for ops with no input AND no errors uses a
    // typed arrow `async (options) => sdkFn(options)`. The earlier
    // re-bind form (`const getX = getX2`) kept the auto-aliased name
    // `getX2` as `fn.name`, which leaked into log lines and error
    // traces. The arrow form fixes that. This is the one runtime
    // assertion against the generated client that's strictly about
    // the codegen — every other behaviour is covered by the
    // `api.test.ts` family.
    const { getCodecObject } = await import('./public-client.ts');
    expect(getCodecObject.name).toBe('getCodecObject');
  });
});
