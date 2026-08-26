/**
 * Cross-client error helpers — published at
 * `@polygonlabs/zod-to-openapi-heyapi/errors` for consumer code that
 * works with errors surfaced by the codegen-emitted SDK wrappers.
 *
 * The wrappers emit per-client `isTransportError` /
 * `isResponseValidationError` / `isWrapperError` type-predicate guards
 * alongside `TransportError` and `ResponseValidationError` classes.
 * Those are the *primary* narrowing API — locally typed against each
 * generated client's error union and accurate at the type level. This
 * module is the *secondary* surface:
 *
 *   - **Cross-client utilities** that work on values from any
 *     generated client (e.g., a logging adapter that doesn't want to
 *     import per-client types).
 *   - **Categorization** for code paths where the consumer wants to
 *     branch on the failure mode without writing the four-branch
 *     narrow themselves at every call site.
 *   - **Symbol-key constants** for power users hand-rolling
 *     introspection (e.g., custom error-reporting middleware that
 *     records a category tag).
 *
 * Everything here is structural — it checks the symbol-keyed marker
 * the wrappers set at construction time. No `instanceof`, no class
 * imports, cross-realm safe (the marker uses `Symbol.for(...)`, which
 * is identity-stable across realms / module copies / iframes /
 * workers). Two separately-generated clients in the same process
 * produce mutually-narrowable instances.
 *
 * The structural {@link ResponseValidationError} interface types
 * `cause` as `ZodError` so cross-client consumers reach
 * `cause.format()` / `cause.flatten()` / `cause.issues` without a
 * cast. `zod` is already a peer dependency (every generated client
 * imports it at runtime for `parseAsync`), so requiring it for the
 * `/errors` subpath isn't a new ask. The import is type-only — this
 * module has no runtime dependency on `zod`.
 */

import type { ZodError } from 'zod';

// ── Symbol-key constants ─────────────────────────────────────────────────────

/**
 * Global symbol the wrapper sets on every emitted `TransportError`
 * instance. Power users wanting to do their own narrowing can read
 * `(value as Record<symbol, unknown>)[TRANSPORT_ERROR_MARKER]` — same
 * check the type-predicate guard performs. Most consumers should use
 * {@link isTransportError} instead.
 */
export const TRANSPORT_ERROR_MARKER: unique symbol = Symbol.for(
  '@polygonlabs/zod-to-openapi-heyapi/is-transport-error'
);

/**
 * Global symbol the wrapper sets on every emitted
 * `ResponseValidationError` instance. See {@link TRANSPORT_ERROR_MARKER}.
 */
export const RESPONSE_VALIDATION_ERROR_MARKER: unique symbol = Symbol.for(
  '@polygonlabs/zod-to-openapi-heyapi/is-response-validation-error'
);

// ── Structural classes (typed surface for consumer code) ────────────────────

/**
 * Structural type for the `TransportError` instance the wrapper
 * emits. Identical to the per-client class the codegen produces; we
 * re-declare it here rather than import from a generated file
 * because this module ships in the published `@polygonlabs/zod-to-
 * openapi-heyapi` package and can't reach into a consumer's
 * generated client.
 *
 * `cause` is the native fetch error (`TypeError`, `AbortError`, Node
 * `SystemError` carrying `.code === 'ECONNRESET'` / `'ETIMEDOUT'` /
 * `'ENOTFOUND'`). `parseAsync` is **not** run against transport
 * failures — there is no body to validate.
 */
export interface TransportError extends Error {
  readonly cause: Error;
}

/**
 * Structural type for the `ResponseValidationError` instance the
 * wrapper emits. Same rationale as {@link TransportError} — re-
 * declared structurally so this module doesn't depend on per-client
 * generation.
 *
 * The class is *always* constructed the same way:
 * `new ResponseValidationError(zodError, body)`, from either of two
 * sites: the per-op response transformer, when a SUCCESS (2xx) body
 * fails `parseAsync` against the registered response schema; or the
 * SDK wrapper, when an error-status body fails `parseAsync` against
 * every registered error schema. `cause` is the `ZodError` —
 * cross-client consumers reach `.format()` / `.flatten()` / `.issues`
 * directly; `body` is the body that failed parse. Both fields are one
 * hop from the wrapper-error — symmetric with `TransportError.cause`.
 *
 * `body` is the POST-`JSON.parse` value (hey-api's fetch client parses
 * before any plugin code runs), so it is faithful evidence for schema
 * drift (wrong types, missing fields, renamed keys) but not a raw-text
 * capture: a JSON number too large for IEEE-754 has already lost
 * precision by the time it lands here. Diagnosis, not recovery.
 */
export interface ResponseValidationError extends Error {
  readonly cause: ZodError;
  readonly body: unknown;
}

// ── Type-predicate guards ────────────────────────────────────────────────────

/**
 * Cross-client type-predicate guard for {@link TransportError}.
 * Identical contract to the per-client `isTransportError` the
 * codegen emits — checks the global symbol marker. Use the
 * codegen-emitted guard when narrowing within a single client (it
 * carries the per-client class identity); use this one when working
 * across multiple clients or in a logging adapter that doesn't know
 * which client produced the error.
 */
export function isTransportError(value: unknown): value is TransportError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[TRANSPORT_ERROR_MARKER] === true
  );
}

/**
 * Cross-client type-predicate guard for {@link ResponseValidationError}.
 * See {@link isTransportError} for the per-client / cross-client
 * distinction.
 */
export function isResponseValidationError(value: unknown): value is ResponseValidationError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[RESPONSE_VALIDATION_ERROR_MARKER] === true
  );
}

/**
 * "Either category" guard for {@link TransportError} or
 * {@link ResponseValidationError}. Saves writing
 * `isTransportError(x) || isResponseValidationError(x)` at every
 * "log any wrapper-emitted error" call site.
 */
export function isWrapperError(value: unknown): value is TransportError | ResponseValidationError {
  return isTransportError(value) || isResponseValidationError(value);
}

// ── Categorization ───────────────────────────────────────────────────────────

/**
 * Result of {@link categorizeApiError}. A discriminated union over
 * the four categories the runtime helper can authoritatively
 * identify from a value's shape:
 *
 *   - **`transport`** / **`response-validation`** — wrapper-emitted,
 *     identified via the symbol-keyed marker. Always typed.
 *   - **`native-error`** — native `Error` instance from a non-wrapper
 *     code path (e.g., the codec-aware TanStack Query factory's
 *     `queryFn` rejecting with a fetch error).
 *   - **`other`** — everything else, including typed `${Op}Error`
 *     values from the wrapper's success-branch return type.
 *
 * **No `typed` branch.** The runtime helper deliberately doesn't
 * include a typed-error category. The wrapper's return type is
 * already statically narrowed to the per-op
 * `${Op}Error | TransportError | ResponseValidationError | undefined`
 * union, so once a consumer peels off `transport` and `response-
 * validation` the remaining static type IS the typed `${Op}Error`. A
 * runtime helper inventing a magic-string convention (e.g.,
 * `{ code: string; message: string }`) for the typed branch would
 * lose type information the wrapper return already carries.
 *
 * Consumer pattern (no `as` casts, no type hints):
 *
 *   const { data, error } = await getX();           // typed return
 *   if (isTransportError(error))            { ... }
 *   else if (isResponseValidationError(error)) { ... }
 *   else if (error)                          { ... }   // ${Op}Error, fully typed
 *
 * Use {@link categorizeApiError} only when you don't have access to
 * the wrapper return type — typically logging adapters and
 * cross-client middleware. Consumers with per-op typed returns
 * should use the wrapper-emitted guards directly.
 */
export type ErrorCategory =
  | {
      /** Wrapper-emitted: request never reached the API. */
      readonly kind: 'transport';
      readonly error: TransportError;
    }
  | {
      /** Wrapper-emitted: response body didn't match any registered schema. */
      readonly kind: 'response-validation';
      readonly error: ResponseValidationError;
    }
  | {
      /**
       * Native `Error` from a non-wrapper code path. Most commonly
       * the codec-aware TanStack Query factory: its `queryFn` calls
       * the raw SDK with `throwOnError: true` so a fetch rejection
       * lands here unwrapped (the wrapper isn't in that path — by
       * design, since the queryKey carries pre-encoded codec values
       * that the wrapper would re-encode).
       *
       * Functionally identical to `transport` for retry / network-
       * issue UX. Surfaced separately so telemetry can split them.
       */
      readonly kind: 'native-error';
      readonly error: Error;
    }
  | {
      /**
       * Anything that isn't a wrapper-emitted error or a native
       * `Error`. In practice this is almost always a typed
       * `${Op}Error` value from a wrapper return — but the runtime
       * helper can't authoritatively identify it without per-op
       * type information, so it's surfaced as `other`.
       *
       * If the consumer has the typed return in scope (the common
       * case), they shouldn't be calling categorizeApiError at all
       * — the wrapper return's static union narrows correctly via
       * the predicates. categorizeApiError is for code paths that
       * have lost the typed return (logging, generic middleware).
       */
      readonly kind: 'other';
      readonly error: unknown;
    };

/**
 * Categorise a caught error value into the four runtime-identifiable
 * categories. Returns a discriminated union the consumer can switch
 * over without further narrowing inside the wrapper-error branches.
 *
 * Order: the wrapper-emitted categories are checked first via their
 * symbol-keyed markers (deterministic); then native `Error`; then
 * `other`. A value matches at most one category.
 *
 * Recommended for cross-client / generic code (logging adapters,
 * error-reporting middleware). For per-client narrowing in code
 * with the wrapper return type in scope, use the wrapper-emitted
 * predicates directly — they integrate with TS flow narrowing on
 * the typed return shape:
 *
 *   import { getX, isTransportError, isResponseValidationError } from '@my-org/api-client';
 *
 *   const { error } = await getX();
 *   if (isTransportError(error))            log.network(error.cause);
 *   else if (isResponseValidationError(error)) log.schemaDrift(error);
 *   else if (error)                          handleTyped(error);   // typed ${Op}Error
 *
 * No imports from `./generated/...gen.js` — the consumer's `@my-org/api-client`
 * package is expected to re-export the codegen-emitted guards as
 * part of its public surface.
 */
export function categorizeApiError(value: unknown): ErrorCategory {
  if (isTransportError(value)) {
    return { kind: 'transport', error: value };
  }
  if (isResponseValidationError(value)) {
    return { kind: 'response-validation', error: value };
  }
  if (value instanceof Error) {
    return { kind: 'native-error', error: value };
  }
  return { kind: 'other', error: value };
}

/**
 * Best-effort message extractor for log lines and fallback toast
 * copy where the consumer doesn't want to inline the narrowing
 * pattern.
 *
 * Returns `error.message` for `Error` instances (this includes
 * wrapper-emitted `TransportError` / `ResponseValidationError`, which
 * extend `Error`). Falls back to the supplied string for non-`Error`
 * values — including typed `${Op}Error` shapes, since the runtime
 * helper deliberately doesn't invent a `{ code, message }`
 * convention. Consumers with per-op typed errors in scope should
 * read `error.message` directly off the typed return type.
 *
 * Never throws. Never returns the empty string (falls back when
 * `error.message` is empty).
 */
export function getApiErrorMessage(value: unknown, fallback: string = 'Unknown error'): string {
  if (value instanceof Error && value.message) return value.message;
  return fallback;
}
