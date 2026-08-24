/**
 * Generate-time audit: no coercing schemas (`z.coerce.*`) in parameter
 * positions.
 *
 * In zod v4 a coercing schema's INPUT type is `unknown` — `z.coerce.number()`
 * accepts `undefined` at the type level — so `@asteasolutions/zod-to-openapi`
 * derives `required: false, nullable: true` for the parameter REGARDLESS of
 * whether the author marked it `.optional()`. A required query param
 * silently documents as optional-and-nullable: the spec misstates the
 * contract, every codegen consumer inherits the lie, and nothing fails
 * anywhere. (Live specimen: a required `network_id` query param authored as
 * `z.coerce.number().int().nonnegative()` generated `required: false,
 * nullable: true`.)
 *
 * Coercion is also the wrong tool at this boundary: parameters arrive as
 * strings, and the conversion belongs to the server binding (which parses
 * `"42"` into the declared logical type) or to an explicit codec that
 * declares BOTH sides (`Int64Codec` et al. from `@polygonlabs/zod-codecs` —
 * wire schema and runtime type, honestly documented). `z.coerce` declares
 * neither: it hides the wire type from the spec and the conversion from the
 * reader.
 *
 * The audit runs inside `TypedRegistry.registerPath` and THROWS — same
 * philosophy as the sealed shared registry: catch the contract corruption
 * on the engineer's machine at generate time, before any YAML exists.
 * It walks `request.params` / `request.query` / `request.headers` (the
 * string-boundary positions where `z.coerce` gets reached for), unwrapping
 * `.optional()` / `.nullable()` / `.default()` / `.catch()` / `.readonly()`
 * wrappers via `innerType`. Codecs are untouched — a `z.codec(...)` is a
 * `pipe`, not a coercing schema, and is the sanctioned replacement.
 */

/**
 * Structural slice of a zod v4 internal def. Read defensively (`def` with
 * `_def` fallback) so the audit degrades to a no-op rather than crashing
 * if zod's internals shift — a missed audit is recoverable (the spec review
 * catches it); a registry that throws on valid schemas is not.
 */
type ZodDefSlice = {
  type?: string;
  coerce?: boolean;
  innerType?: unknown;
  shape?: Record<string, unknown>;
};

function defOf(schema: unknown): ZodDefSlice | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const s = schema as { def?: ZodDefSlice; _def?: ZodDefSlice };
  return s.def ?? s._def;
}

/** Unwraps optional/nullable/default/catch/readonly wrappers to the base def. */
function unwrapDef(def: ZodDefSlice | undefined): ZodDefSlice | undefined {
  let current = def;
  let guard = 0;
  while (current?.innerType !== undefined && guard < 20) {
    const inner = defOf(current.innerType);
    if (!inner) break;
    current = inner;
    guard += 1;
  }
  return current;
}

const PARAM_SECTIONS = ['params', 'query', 'headers'] as const;

type RouteShapeForAudit = {
  operationId: string;
  request?: {
    params?: unknown;
    query?: unknown;
    headers?: unknown;
  };
};

/**
 * Throws if any parameter-position schema on the route is a coercing
 * schema, naming the route, section, and property plus the sanctioned
 * replacements. No-op for routes without `request`.
 */
export function assertNoCoercingParamSchemas(route: RouteShapeForAudit): void {
  const request = route.request;
  if (!request) return;

  for (const section of PARAM_SECTIONS) {
    const sectionSchema = request[section];
    if (!sectionSchema) continue;

    // asteasolutions permits `headers` as either a single object schema or
    // an array of schemas; normalise to an array.
    const schemas = Array.isArray(sectionSchema) ? sectionSchema : [sectionSchema];
    for (const schema of schemas) {
      const base = unwrapDef(defOf(schema));
      if (base?.coerce === true) {
        throwCoercionError(route.operationId, section, null);
      }
      const shape = base?.shape;
      if (!shape) continue;
      for (const [property, propertySchema] of Object.entries(shape)) {
        const propertyDef = unwrapDef(defOf(propertySchema));
        if (propertyDef?.coerce === true) {
          throwCoercionError(route.operationId, section, property);
        }
      }
    }
  }
}

function throwCoercionError(
  operationId: string,
  section: (typeof PARAM_SECTIONS)[number],
  property: string | null
): never {
  const where = property === null ? `request.${section}` : `request.${section}.${property}`;
  throw new Error(
    `[openapi-registry] Route '${operationId}': ${where} uses a coercing schema ` +
      `(z.coerce.*). In zod v4 a coercing schema's input type is 'unknown', so the ` +
      `generated OpenAPI marks this parameter optional and nullable regardless of ` +
      `intent — the spec silently misdocuments the contract. Declare the logical ` +
      `type plainly (e.g. z.number().int()) and let the server binding convert the ` +
      `incoming string, or use a codec that declares both wire and runtime sides ` +
      `(e.g. Int64Codec from @polygonlabs/zod-codecs).`
  );
}
