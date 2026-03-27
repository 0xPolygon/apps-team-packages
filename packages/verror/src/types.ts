export interface VErrorOptions {
  cause?: Error;
  info?: Record<string, unknown>;
  /**
   * The function to treat as the top of the stack trace for
   * `Error.captureStackTrace`. Frames at or below this function are omitted.
   * Defaults to the constructor of the class being instantiated.
   */
  constructorOpt?: ((...args: unknown[]) => unknown) | null;
  /**
   * @internal Used by WError to suppress cause message appending.
   * Do not set this directly — use WError instead.
   */
  skipCauseMessage?: boolean;
}
