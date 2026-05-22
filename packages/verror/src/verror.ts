import type { VErrorOptions } from './types.ts';

/**
 * Serialises any Error to the canonical VError JSON shape so that the full
 * cause chain is preserved when errors are transmitted over RPC or stored in
 * logs.  Plain `Error` instances (which would otherwise serialise to `{}`)
 * receive the same structure as VError: `name`, `message`, `shortMessage`,
 * `cause`, `info`.
 *
 * Called automatically by `VError.toJSON()`.  Export it if you need to
 * serialise errors that are not necessarily VErrors themselves.
 */
export function serializeError(err: unknown): Record<string, unknown> | undefined {
  if (!(err instanceof Error)) return undefined;
  // VError (and subclasses like HTTPError) already have toJSON — delegate so
  // that subclass-specific fields (statusCode, errors, etc.) are included.
  if (typeof (err as VError).toJSON === 'function') {
    return (err as VError).toJSON();
  }
  // Plain Error: produce the same shape so the receiver can handle it uniformly.
  return {
    name: err.name,
    message: err.message,
    shortMessage: err.message,
    cause: serializeError((err as { cause?: unknown }).cause),
    info: {}
  };
}

export class VError extends Error {
  // Explicit `: string` so subclasses can narrow with `as const` to their own literal.
  override readonly name: string = 'VError';

  /**
   * Returns the fully accumulated message for `cause`, walking native Error
   * cause chains so VError produces a complete message even when some links
   * are plain Errors that did not append their own cause message.
   *
   * VError instances already carry the full accumulated chain in `.message`
   * and are returned directly.  WError is a VError whose `.message` is its
   * own message only (by design), so it naturally stops the accumulation.
   */
  private static accumulateCauseMessage(cause: Error): string {
    if (cause instanceof VError) return cause.message;
    const nested = (cause as { cause?: unknown }).cause;
    if (nested instanceof Error && nested.message) {
      const nestedMsg = VError.accumulateCauseMessage(nested);
      return nestedMsg ? `${cause.message}: ${nestedMsg}` : cause.message;
    }
    return cause.message;
  }

  /** The message as passed to the constructor, before the cause chain was appended. */
  readonly shortMessage: string;

  /**
   * Structured informational properties attached at construction time.
   * Use `VError.info(err)` to get the merged set from the full cause chain.
   */
  readonly info: Record<string, unknown>;

  constructor(message: string, options?: VErrorOptions) {
    const { cause, constructorOpt, info: infoOpt = {} } = options ?? {};

    // W-by-default classes (WError, HTTPError, and any subclass that sets
    // the marker on its prototype) suppress cause-message accumulation.
    // Read from the *prototype* via `new.target` so the marker is visible
    // here in the base constructor, before subclass instance-field
    // initialisers have run. `new.target` points at the most-derived
    // constructor; prototype-chain lookup picks the symbol up no matter
    // which ancestor set it.
    const isWError =
      new.target !== undefined &&
      WERROR_SYMBOL in new.target.prototype &&
      (new.target.prototype as Record<symbol, unknown>)[WERROR_SYMBOL] === true;

    let fullMessage = message;
    if (cause != null && !isWError) {
      const causeMsg = VError.accumulateCauseMessage(cause);
      if (causeMsg) fullMessage = message === '' ? causeMsg : `${message}: ${causeMsg}`;
    }

    super(fullMessage);

    this.message = fullMessage;
    this.shortMessage = message;

    if (cause != null) {
      Object.defineProperty(this, 'cause', {
        value: cause,
        writable: true,
        configurable: true,
        enumerable: false
      });
    }

    this.info = {};
    for (const k of Object.keys(infoOpt)) this.info[k] = infoOpt[k];

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, constructorOpt ?? new.target);
    }
  }

  override toString(): string {
    const name =
      (Object.prototype.hasOwnProperty.call(this, 'name') && this.name) ||
      this.constructor.name ||
      this.constructor.prototype.name;
    return this.message ? `${name}: ${this.message}` : name;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      shortMessage: this.shortMessage,
      cause: serializeError((this as { cause?: unknown }).cause),
      info: this.info
    };
  }

  // ─── Static helpers ────────────────────────────────────────────────────────

  /**
   * Returns the immediate cause of `err`, or null.  Unlike reading `err.cause`
   * directly (typed as `unknown` on the base Error class), this validates that
   * the cause is an actual Error and returns a typed result.
   */
  static cause(err: Error): Error | null {
    if (!(err instanceof Error)) throw new Error('err must be an Error');
    const c = (err as { cause?: unknown }).cause;
    return c instanceof Error ? c : null;
  }

  /**
   * Returns the merged info object for the entire cause chain of `err`.
   * Deeper causes appear first; closer causes override their values.
   */
  static info(err: Error): Record<string, unknown> {
    if (!(err instanceof Error)) throw new Error('err must be an Error');
    const cause = VError.cause(err);
    const rv = cause !== null ? VError.info(cause) : {};
    const errInfo = (err as Partial<VError>).info;
    if (errInfo !== null && typeof errInfo === 'object') Object.assign(rv, errInfo);
    return rv;
  }

  /** Walk the cause chain and return the first Error whose `name` matches. */
  static findCauseByName(err: Error, name: string): Error | null {
    if (!(err instanceof Error)) throw new Error('err must be an Error');
    if (typeof name !== 'string') throw new Error('name (string) is required');
    if (name.length === 0) throw new Error('name cannot be empty');
    for (let cause: Error | null = err; cause !== null; cause = VError.cause(cause)) {
      if (cause.name === name) return cause;
    }
    return null;
  }

  /**
   * Walk the cause chain and return the first Error that is `instanceof type`.
   *
   * The constraint uses `{ prototype: T }` rather than a constructor signature
   * because TypeScript types built-in constructors (e.g. `Error`) with specific
   * parameter types like `(message?: string)`, which are not compatible with a
   * fully generic `new (...args: unknown[]) => T` form.  `instanceof` only
   * inspects the prototype chain, so `{ prototype: T }` is the correct shape.
   */
  static findCauseByType<T extends Error>(err: Error, type: { prototype: T }): T | null {
    if (!(err instanceof Error)) throw new Error('err must be an Error');
    if (typeof type !== 'function') throw new Error('type (func) is required');
    for (let cause: Error | null = err; cause !== null; cause = VError.cause(cause)) {
      if (cause instanceof (type as abstract new (...args: unknown[]) => T)) return cause;
    }
    return null;
  }

  static hasCauseWithName(err: Error, name: string): boolean {
    return VError.findCauseByName(err, name) !== null;
  }

  static hasCauseWithType<T extends Error>(err: Error, type: { prototype: T }): boolean {
    return VError.findCauseByType(err, type) !== null;
  }

  /** Concatenates the full stack trace including all chained causes. */
  static fullStack(err: Error): string {
    if (!(err instanceof Error)) throw new Error('err must be an Error');
    const cause = VError.cause(err);
    const stack = err.stack ?? '';
    return cause !== null ? `${stack}\ncaused by: ${VError.fullStack(cause)}` : stack;
  }

  /**
   * Given an array of errors, returns null (empty), the single error (one
   * item), or a new `MultiError` wrapping all of them.
   */
  static errorFromList(errors: Error[]): Error | null {
    if (!Array.isArray(errors)) throw new Error('list of errors (array) is required');
    if (errors.length === 0) return null;
    for (const e of errors) {
      if (!(e instanceof Error)) throw new Error('each item must be an Error');
    }
    return errors.length === 1 ? errors[0] : new MultiError(errors);
  }

  /**
   * Calls `func` once for each contained error: once for a plain Error,
   * once per element for a MultiError.
   */
  static errorForEach(err: Error, func: (e: Error) => void): void {
    if (!(err instanceof Error)) throw new Error('err must be an Error');
    if (typeof func !== 'function') throw new Error('func (func) is required');
    if ((err as unknown as Record<symbol, unknown>)[MULTIERROR_SYMBOL] === true) {
      for (const e of (err as MultiError).errors) func(e);
    } else {
      func(err);
    }
  }
}

// ─── WError ────────────────────────────────────────────────────────────────────

/**
 * Cross-boundary identity marker for WError and its subclasses.
 *
 * Uses Symbol.for() so the same symbol is returned from the global registry
 * regardless of which module copy of @polygonlabs/verror is loaded — unlike
 * `instanceof`, which breaks when the host and a dependency have separate
 * copies of the class.
 *
 * Check with: `(err as Record<symbol, unknown>)[WERROR_SYMBOL] === true`
 */
export const WERROR_SYMBOL: unique symbol = Symbol.for('@polygonlabs/verror/is-werror');

/**
 * Cross-boundary identity marker for MultiError and its subclasses.
 *
 * Uses Symbol.for() so the same symbol is returned from the global registry
 * regardless of which module copy of @polygonlabs/verror is loaded — unlike
 * `instanceof`, which breaks when the host and a dependency have separate
 * copies of the class.
 *
 * Check with: `(err as Record<symbol, unknown>)[MULTIERROR_SYMBOL] === true`
 */
export const MULTIERROR_SYMBOL: unique symbol = Symbol.for('@polygonlabs/verror/is-multierror');

/**
 * A "wrapped error" — like VError but the cause's message is intentionally
 * NOT appended to this error's own message. The cause is still traversable
 * via `VError.cause()` and serialised under `cause` by `serializeError` /
 * `toJSON`, but neither `.message` nor `.toString()` mention it.
 *
 * Use WError when you want to wrap a lower-level error with a distinct
 * higher-level description without the noise (or risk) of duplicating the
 * cause message. The boundary semantics are uniform across `.message` and
 * `.toString()` — anywhere the error is stringified, only its own message
 * surfaces. Code that wants the cause walks `err.cause` explicitly.
 *
 * Identity is signalled by `WERROR_SYMBOL` on this class's prototype (set
 * in the static block below). `VError`'s constructor reads it via
 * `new.target.prototype` during `super()` and suppresses cause-message
 * accumulation. Subclasses inherit the marker automatically — no custom
 * constructor or per-class wiring needed.
 */
export class WError extends VError {
  override readonly name: string = 'WError';

  static {
    // Symbol on the prototype (not an instance field) so `VError`'s
    // constructor sees it through `new.target.prototype` during `super()`,
    // before any subclass instance-field initialisers have run. Any class
    // extending WError (or any class that sets the same marker on its own
    // prototype, e.g. `HTTPError`) is treated as a boundary wrapper.
    (WError.prototype as unknown as Record<symbol, unknown>)[WERROR_SYMBOL] = true;
  }

  // Type-narrowing constructor: WError exists to wrap something, so
  // `cause: Error` is required on the public API. The runtime behaviour
  // (suppress cause-message accumulation) is derived from the prototype
  // marker above and works equally well for any subclass — this override
  // is purely about the type signature at the call site.
  constructor(message: string, options: VErrorOptions & { cause: Error }) {
    super(message, options);
  }
}

// ─── MultiError ────────────────────────────────────────────────────────────────

/**
 * Represents a collection of errors for callers that normally deal with a
 * single error but need to surface multiple failures.  The first error in the
 * list is used as the cause; all errors are accessible via `err.errors`.
 */
export class MultiError extends VError {
  override readonly name: string = 'MultiError';

  // Presence of this property (checked via MULTIERROR_SYMBOL) identifies MultiError
  // and its subclasses across module boundaries without relying on instanceof.
  readonly [MULTIERROR_SYMBOL] = true;

  readonly errors: readonly Error[];

  constructor(errors: Error[]) {
    if (!Array.isArray(errors)) throw new Error('list of errors (array) is required');
    if (errors.length === 0) throw new Error('must be at least one error');

    super(`first of ${errors.length} error${errors.length === 1 ? '' : 's'}`, {
      cause: errors[0]
    });

    this.errors = [...errors];
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), errors: this.errors.map(serializeError) };
  }
}
