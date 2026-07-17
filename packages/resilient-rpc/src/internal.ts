/** Object-shape guard used to read fields off unknown error values safely. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Normalises a thrown non-Error (string, object) into an Error for `cause`. */
export const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));
