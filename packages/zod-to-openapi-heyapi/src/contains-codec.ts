/**
 * Codec detection for the loud-failure guard.
 *
 * The plugin resolves a route's `request.{params, query, body, headers}`
 * schema to its registration name (refId) so it can emit
 * `import { Name } from '<schemasFrom>'` + `z.encode(Name, value)`. When a
 * slot is unregistered, its input encoding is skipped — fine for anonymous
 * inline schemas, but catastrophic for a codec-bearing slot: the emitted
 * client would type the slot wire-shaped and never run `z.encode`, sending
 * wire-invalid values (e.g. a `Date` serialised as a locale string instead
 * of ISO-8601) while compiling clean. The guard needs to know whether an
 * unregistered slot carries a codec, and it needs to know that *without*
 * relying on shared module identity — codegen may run under a split module
 * evaluation (c12/jiti config loader vs native loader), so the walk is
 * duck-typed over zod's internal def tree, never `instanceof`.
 */

/**
 * The internal definition object of a Zod schema, duck-typed. Zod 4
 * exposes it as `schema._zod.def` (with `_def` kept as an alias); checks
 * inside `def.checks` carry their own `_zod.def`. Returns `undefined` for
 * anything that doesn't look like a Zod-internal carrier.
 */
function getZodDef(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const internals = (value as { _zod?: unknown })._zod;
  if (typeof internals === 'object' && internals !== null) {
    const def = (internals as { def?: unknown }).def;
    if (typeof def === 'object' && def !== null) return def as Record<string, unknown>;
  }
  const def = (value as { _def?: unknown })._def;
  if (typeof def === 'object' && def !== null) return def as Record<string, unknown>;
  return undefined;
}

/**
 * Whether a Zod schema contains a codec anywhere in its def tree.
 *
 * Duck-typed signature: `z.codec(...)` produces a pipe whose def carries a
 * function-valued `reverseTransform` (the encode direction) — plain
 * `z.pipe`/`z.transform` have no encode, so they don't trip this. The walk
 * recurses through wrappers (`optional`, `nullable`, `default`...), object
 * shapes, arrays, unions — generically, by visiting every def value.
 */
export function containsCodec(schema: unknown): boolean {
  const def = getZodDef(schema);
  if (!def) return false;
  return defContainsCodec(def, new Set());
}

function defContainsCodec(def: Record<string, unknown>, visited: Set<object>): boolean {
  if (visited.has(def)) return false;
  visited.add(def);
  if (def['type'] === 'pipe' && typeof def['reverseTransform'] === 'function') return true;
  return Object.values(def).some((value) => valueContainsCodec(value, visited));
}

function valueContainsCodec(value: unknown, visited: Set<object>): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (visited.has(value)) return false;
  visited.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => valueContainsCodec(item, visited));
  }
  const def = getZodDef(value);
  if (def) return defContainsCodec(def, visited);
  return Object.values(value).some((item) => valueContainsCodec(item, visited));
}
