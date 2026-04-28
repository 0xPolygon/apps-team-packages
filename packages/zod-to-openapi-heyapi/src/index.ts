/**
 * @polygonlabs/zod-to-openapi-heyapi
 *
 * A `@hey-api/openapi-ts` plugin that sources Zod schemas from a
 * `@asteasolutions/zod-to-openapi` `OpenAPIRegistry` instead of regenerating
 * them from the spec. Generated clients import the actual Zod schemas — so
 * codec output types (bigint for int64, string for decimalString, Date for
 * ISO-string codecs, etc.) reach the caller, and `Schema.parseAsync(data)`
 * runs as the response transformer to apply codec decode direction at
 * runtime.
 *
 * The emitted response types are `z.output<typeof Schema>`, delegating type
 * inference to Zod itself. Every construct `z.infer` supports is supported
 * here automatically — tuples, intersections, discriminated unions, lazy /
 * recursive schemas, dates, Set / Map, defaults, branded types, etc.
 *
 * IMPORTANT: list this plugin BEFORE '@hey-api/typescript' in the plugins
 * array — the SDK plugin queries by metadata key and takes the first match,
 * so this plugin's response symbols must be registered first:
 *
 *   plugins: [
 *     registryPlugin({ ... }) as never,   // ← must be first
 *     '@hey-api/typescript',
 *     '@hey-api/client-fetch',
 *     { name: '@hey-api/sdk', transformer: true },
 *   ]
 *
 * See README.md for usage details and the "what doesn't get handled"
 * constraints.
 */

import type { $, IR } from '@hey-api/openapi-ts';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Minimal structural type for the OpenAPI registry. */
interface RegistryLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  definitions: any[];
}

/** Minimal structural type for the generated document. */
interface GeneratedDocument {
  components?: { schemas?: Record<string, unknown> };
  paths?: Record<string, GeneratedPath | undefined>;
}

/** A single path in the OpenAPI document — the methods we walk. */
interface GeneratedPath {
  get?: GeneratedOperation;
  post?: GeneratedOperation;
  put?: GeneratedOperation;
  patch?: GeneratedOperation;
  delete?: GeneratedOperation;
  head?: GeneratedOperation;
  options?: GeneratedOperation;
  trace?: GeneratedOperation;
}

interface GeneratedOperation {
  responses?: Record<string, GeneratedResponse | undefined>;
}

interface GeneratedResponse {
  content?: Record<string, GeneratedMediaType | undefined>;
}

interface GeneratedMediaType {
  schema?: { $ref?: string } & Record<string, unknown>;
}

/** Minimal structural type for the generator class. */
interface GeneratorClass {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new (definitions: any[]): { generateDocument(info: object): GeneratedDocument };
}

/** The hey-api code generation DSL. */
type Dsl = typeof $;

/**
 * Minimal structural interface for the hey-api PluginInstance.
 * Only the methods our plugin actually calls.
 */
interface PluginLike {
  forEach(event: 'operation', callback: (event: { operation: IR.OperationObject }) => void): void;
  symbol(name: string, props?: Record<string, unknown>): Parameters<Dsl>[0];
  querySymbol(filter: Record<string, unknown>): Parameters<Dsl>[0] | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  node(node: any): void;
}

/** The plugin config object returned by registryPlugin(). */
export interface RegistryPluginConfig {
  name: string;
  tags: ReadonlyArray<string>;
  handler(args: { plugin: PluginLike }): void;
}

/** Options for registryPlugin(). */
export interface RegistryPluginOptions {
  /**
   * The registry used to generate the OpenAPI spec. Used to derive the canonical
   * schema name map and to walk schema structures for TypeScript type generation.
   */
  registry: RegistryLike;
  /**
   * The module specifier to import Zod schemas from in the generated transformer.
   * Any valid ES module specifier — npm package root (`@org/pkg`), subpath
   * export (`@org/pkg/zod`), workspace package, or relative path.
   *
   * Schemas must be reachable as **named exports** at this specifier, and
   * each export's name must match the name used when calling
   * `registry.register(name, schema)`. The plugin emits
   * `import { <registeredName> } from '<schemasFrom>'`, so a mismatch between
   * the registry name and the exported binding name breaks the consumer's
   * import. Default and namespace exports are not supported.
   *
   * The schemas are runtime code, not build-time artifacts: the generated
   * transformer calls `Schema.parseAsync(data)` on every response, so the
   * import must resolve in the consumer's runtime environment. For bundled
   * consumers (Vite, webpack, etc.) the bundler embeds the schemas at bundle
   * time and the deployed bundle is self-contained; for unbundled Node
   * consumers the package must be installed in `node_modules` at boot.
   * Either way, the schemas package is a real runtime dependency.
   *
   * Must be a specifier that resolves the same from any caller's perspective:
   * a package specifier (`@org/pkg`, `@org/pkg/zod`), a package.json
   * `imports` alias (`#schemas`), or a `file://` URL. The plugin
   * dynamic-imports this specifier at codegen time to run the audit, so a
   * relative path like `'../schemas'` won't work — its meaning depends on
   * who's importing it, and the plugin's perspective differs from the
   * generated client's. Set up an `imports` alias in your package.json
   * (`"#schemas": "./src/schemas/index.ts"`) and use that for both purposes.
   */
  schemasFrom: string;
  /**
   * The OpenApiGeneratorV3 class from @asteasolutions/zod-to-openapi.
   * Passed explicitly to avoid import resolution issues in the codegen environment.
   */
  generatorClass: GeneratorClass;
  /**
   * The $ DSL from @hey-api/openapi-ts.
   * Passed explicitly to avoid import resolution issues in the codegen environment.
   */
  $: Dsl;
}

// ── Plugin factory ─────────────────────────────────────────────────────────────

export async function registryPlugin({
  registry,
  schemasFrom,
  generatorClass,
  $: dsl
}: RegistryPluginOptions): Promise<RegistryPluginConfig> {
  // Run the generator to determine the canonical schema name list — same call
  // used to produce the spec, so names are guaranteed to match.
  const doc = new generatorClass(registry.definitions).generateDocument({
    openapi: '3.0.0',
    info: { title: '_', version: '0' }
  });
  const registrySchemaNames = new Set(Object.keys(doc.components?.schemas ?? {}));

  // The plugin only emits `import { <Name> } from '<schemasFrom>'` for schemas
  // that appear as a `$ref` in a route response. Building blocks, request
  // bodies, and registered path/query parameters surface in
  // `components.schemas` without ever being referenced by a generated
  // transformer — auditing them was an over-approximation that demanded
  // matching exports for names like `network` (path param) or `LoginRequest`
  // (request body) that the generated client never imports. zod-to-openapi
  // v8's OpenApiGeneratorV3 lifts parameter schemas into components.schemas
  // alongside `components.parameters`, so this trips up any route that uses
  // `registerParameter`.
  //
  // Audit only against the actually-emitted import set: the schemas the
  // plugin's handler will reach via `ensureSchemaImport`. That set is
  // precisely the response-`$ref` schemas, intersected with the registered
  // ones (a `$ref` to an unregistered schema is a malformed spec).
  const auditableSchemaNames = new Set<string>();
  for (const name of collectResponseRefSchemaNames(doc)) {
    if (registrySchemaNames.has(name)) auditableSchemaNames.add(name);
  }

  // Codegen-time audit: dynamic-import schemasFrom and verify every
  // response-referenced schema is exported under the same name. Throws a
  // single aggregated error listing all mismatches so the user can fix them
  // in one pass instead of one round-trip per typo.
  let schemasModule: Record<string, unknown>;
  try {
    schemasModule = (await import(schemasFrom)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(buildSchemasFromImportError(schemasFrom, err));
  }

  const errors: string[] = [];
  for (const name of auditableSchemaNames) {
    if (!(name in schemasModule)) {
      errors.push(
        `'${name}' is referenced as a response schema but is not a named export of '${schemasFrom}'. ` +
          `The plugin emits \`import { ${name} } from '${schemasFrom}'\`, which will fail at consumer build time. ` +
          `Either export ${name} from that module under that exact name, or unregister it.`
      );
      continue;
    }
    const value = schemasModule[name];
    if (!isLikelyZodType(value)) {
      errors.push(
        `'${name}' is exported from '${schemasFrom}' but does not appear to be a Zod schema (got ${describeType(value)}). ` +
          `The plugin emits \`${name}.parseAsync(data)\`, which will fail at consumer runtime.`
      );
    }
  }
  if (errors.length > 0) {
    const header = `[zod-to-openapi-heyapi] codegen-time audit found ${errors.length} issue${errors.length > 1 ? 's' : ''}:`;
    throw new Error(`${header}\n  - ${errors.join('\n  - ')}`);
  }

  return {
    name: 'registry-validator',

    // Tags:
    //   'transformer' — SDK emits responseTransformer: ${opId}Transformer
    //                   client-fetch replaces data with the transformer's return value
    //                   so codec decode (string → bigint etc.) reaches the caller.
    //
    // No 'validator' tag — Schema.parseAsync() throws on invalid input so the
    // transformer already provides validation. A separate requestValidator would
    // discard its return value anyway (client-fetch ignores responseValidator returns).
    tags: ['transformer'],

    handler({ plugin }: { plugin: PluginLike }): void {
      const registeredSchemaImports = new Set<string>();
      let zSymbolRegistered = false;

      const ensureSchemaImport = (name: string): void => {
        if (registeredSchemaImports.has(name)) return;
        registeredSchemaImports.add(name);
        plugin.symbol(name, {
          external: schemasFrom,
          importKind: 'named',
          meta: { category: 'schema', tool: 'zod', resource: 'registry', name }
        });
      };

      const ensureZImport = (): void => {
        if (zSymbolRegistered) return;
        zSymbolRegistered = true;
        plugin.symbol('z', {
          external: 'zod',
          importKind: 'named',
          meta: { category: 'utility', tool: 'zod', name: 'z' }
        });
      };

      plugin.forEach('operation', (event) => {
        const { operation } = event;
        const opId = operation.id;

        // Walk the whole responses map — split into 2xx (Responses) and the
        // rest (Errors). Hey-api's standard typescript plugin uses the same
        // split; the SDK plugin reads {role: 'responses'} and {role: 'errors'}
        // to type the two generic parameters of `client.method<R, E>(...)`.
        const buckets = bucketResponsesByStatus(operation, registrySchemaNames);
        const hasAnyResponse = buckets.success.length > 0 || buckets.error.length > 0;
        if (!hasAnyResponse) return;

        // Imports — schemas referenced by either bucket, plus `z`.
        for (const { schemaName } of [...buckets.success, ...buckets.error]) {
          ensureSchemaImport(schemaName);
        }
        ensureZImport();

        const zSymbol = plugin.querySymbol({ category: 'utility', tool: 'zod', name: 'z' });
        if (!zSymbol) return;

        // z.output<typeof Schema> as a type expression. Closure so each
        // call returns a fresh DSL node — re-using the same node has caused
        // double-rendered imports in some DSL paths.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const zOutputOfSchema = (schemaName: string): any => {
          const sym = plugin.querySymbol({
            category: 'schema',
            tool: 'zod',
            resource: 'registry',
            name: schemaName
          });
          if (!sym) throw new Error(`schema symbol missing for ${schemaName}`);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (dsl.type(zSymbol as any).attr('output') as any).generic(dsl.type.query(dsl(sym)));
        };

        // ── 2xx: Responses + Response ─────────────────────────────────────
        if (buckets.success.length > 0) {
          emitStatusKeyedAlias({
            dsl,
            plugin,
            opId,
            aliasName: capitalizeFirst(opId) + 'Responses',
            unionAliasName: capitalizeFirst(opId) + 'Response',
            role: 'responses',
            unionRole: 'response',
            entries: buckets.success,
            zOutputOfSchema
          });
        }

        // ── non-2xx: Errors + Error ───────────────────────────────────────
        if (buckets.error.length > 0) {
          emitStatusKeyedAlias({
            dsl,
            plugin,
            opId,
            aliasName: capitalizeFirst(opId) + 'Errors',
            unionAliasName: capitalizeFirst(opId) + 'Error',
            role: 'errors',
            unionRole: 'error',
            entries: buckets.error,
            zOutputOfSchema
          });
        }

        // ── Transformer ───────────────────────────────────────────────────
        // client-fetch invokes responseTransformer on every 2xx response,
        // regardless of which status fired — and the transformer has no
        // way to dispatch on the status code at runtime. So when an op
        // has multiple distinct 2xx schemas, the transformer must accept
        // any of them: emit a `z.union(...)` whose runtime parses any of
        // the schemas and whose static type is the union of their outputs.
        // For the common single-schema case (one 2xx, or multiple 2xx
        // sharing one schema), the transformer is the simple
        // `Schema.parseAsync(data)` form.
        const distinctSuccessSchemas = uniqueSchemaNames(buckets.success);
        if (distinctSuccessSchemas.length === 0) return;

        const successSchemaSymbols = distinctSuccessSchemas.map((schemaName) => {
          const sym = plugin.querySymbol({
            category: 'schema',
            tool: 'zod',
            resource: 'registry',
            name: schemaName
          });
          if (!sym) throw new Error(`schema symbol missing for ${schemaName}`);
          return { schemaName, sym };
        });

        const transformerSymbol = plugin.symbol(`${opId}Transformer`, {
          meta: {
            category: 'transform',
            resource: 'operation',
            resourceId: opId,
            role: 'response'
          }
        });

        // Transformer body — either `Schema.parseAsync(data)` or
        // `z.union([A, B, ...]).parseAsync(data)`.
        const transformerBody =
          successSchemaSymbols.length === 1
            ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
              dsl(successSchemaSymbols[0]!.sym as any)
            : dsl(zSymbol)
                .attr('union')
                .call(
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  dsl.array(...successSchemaSymbols.map(({ sym }) => dsl(sym) as any)) as any
                );

        // Return type — either `Promise<z.output<typeof Schema>>` or
        // `Promise<z.output<typeof A> | z.output<typeof B> | ...>`.
        const successOutputs = distinctSuccessSchemas.map((s) => zOutputOfSchema(s));
        const successUnionType =
          successOutputs.length === 1
            ? successOutputs[0]
            : // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (dsl.type.or as (...args: any[]) => unknown)(...successOutputs);

        plugin.node(
          dsl
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .const(transformerSymbol as any)
            .export()
            .assign(
              dsl
                .func()
                .async()
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .param('data', (p: any) => p.type(dsl.type('unknown')))
                .returns(
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  dsl.type('Promise').generic(successUnionType as any) as any
                )
                .do(transformerBody.attr('parseAsync').call('data').await().return())
            )
        );
      });
    }
  };
}

/** Distinct schema names from a list of status entries, preserving spec order. */
function uniqueSchemaNames(entries: StatusEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { schemaName } of entries) {
    if (!seen.has(schemaName)) {
      seen.add(schemaName);
      out.push(schemaName);
    }
  }
  return out;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const HTTP_METHODS = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'trace'
] as const satisfies ReadonlyArray<keyof GeneratedPath>;

/**
 * Walk the generated document's `paths` and collect every schema name
 * referenced via `$ref` from a route response's media-type schema.
 *
 * This is the authoritative set of schemas the plugin will emit
 * `import { Name } from '<schemasFrom>'` for. Schemas that only appear in
 * `components.schemas` because of a request body or a registered path /
 * query parameter never reach the generated client and are deliberately
 * excluded.
 */
function collectResponseRefSchemaNames(doc: GeneratedDocument): Set<string> {
  const names = new Set<string>();
  const paths = doc.paths ?? {};
  for (const path of Object.values(paths)) {
    if (!path) continue;
    for (const method of HTTP_METHODS) {
      const op = path[method];
      if (!op) continue;
      const responses = op.responses ?? {};
      for (const response of Object.values(responses)) {
        const content = response?.content ?? {};
        for (const mediaType of Object.values(content)) {
          const ref = mediaType?.schema?.$ref;
          if (typeof ref !== 'string') continue;
          const name = ref.split('/').pop();
          if (name) names.add(name);
        }
      }
    }
  }
  return names;
}

/**
 * Compose the error thrown when `await import(schemasFrom)` fails. The cause
 * is almost always one of:
 *
 * 1. The schemas package isn't installed (specifier wrong).
 * 2. The package is installed but the runtime entrypoint resolves to a
 *    `dist/` that hasn't been built — common in monorepos that use a
 *    custom export condition for build-free dev (e.g. `@polygonlabs/source`).
 *    Run `node` with that condition active or build the schemas package
 *    before regenerating.
 * 3. The user passed a relative path like `'../schemas'` — these don't
 *    work because the plugin's resolution origin (its install location in
 *    `node_modules`) differs from the generated client's.
 */
function buildSchemasFromImportError(schemasFrom: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  const isModuleNotFound =
    err instanceof Error &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND';

  let hint =
    `\`schemasFrom\` must be a specifier that resolves from the plugin's perspective at codegen time — ` +
    `a package specifier (\`@org/pkg\`, \`@org/pkg/zod\`), a package.json imports alias (\`#schemas\`) ` +
    `for schemas living inside this same package, or a \`file://\` URL. ` +
    `Relative paths like \`'../schemas'\` don't work because they mean different things to the plugin ` +
    `and the generated client.`;

  if (isModuleNotFound) {
    hint +=
      `\n\nERR_MODULE_NOT_FOUND usually means one of:\n` +
      `  • The schemas package isn't installed in the consumer's \`node_modules\`.\n` +
      `  • The package is installed, but its runtime entrypoint resolves to a \`dist/\` ` +
      `that hasn't been built yet. If you're using a custom export condition for build-free ` +
      `dev (e.g. \`@polygonlabs/source\`), either run \`node --conditions=<your-condition>\` ` +
      `before \`openapi-ts\`, or build the schemas package first.\n` +
      `  • You passed a relative path. Use a package specifier or a \`#imports\` alias instead.`;
  }

  return `[zod-to-openapi-heyapi] Could not import schemasFrom='${schemasFrom}'. Cause: ${detail}\n\n${hint}`;
}

/**
 * Duck-type check for Zod schemas. Avoids an `instanceof ZodType` dependency
 * (which would couple this package to a specific zod version's class
 * identity, breaking when consumers have multiple zod copies in their
 * dependency tree). All ZodType instances expose `_def` and `parseAsync`;
 * either is a strong indicator.
 */
function isLikelyZodType(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { _def?: unknown; parseAsync?: unknown };
  return '_def' in candidate || typeof candidate.parseAsync === 'function';
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

interface StatusEntry {
  status: string;
  schemaName: string;
}

interface ResponseBuckets {
  success: StatusEntry[]; // 2xx, in spec order
  error: StatusEntry[]; // non-2xx with a registered schema, in spec order
}

/**
 * Walk an operation's responses map, extract the schema name from each
 * status code's $ref, and split into success (2xx) and non-success buckets.
 * Statuses without a $ref to a registered schema are dropped — there's no
 * Zod schema to bind a type or transformer to.
 */
function bucketResponsesByStatus(
  operation: IR.OperationObject,
  registrySchemaNames: ReadonlySet<string>
): ResponseBuckets {
  const success: StatusEntry[] = [];
  const error: StatusEntry[] = [];
  const responses = operation.responses ?? {};
  for (const [status, response] of Object.entries(responses)) {
    if (!response) continue;
    const schemaName = extractSchemaName(response.schema);
    if (!schemaName || !registrySchemaNames.has(schemaName)) continue;
    const code = Number(status);
    const entry: StatusEntry = { status, schemaName };
    if (code >= 200 && code < 300) success.push(entry);
    else error.push(entry);
  }
  return { success, error };
}

interface EmitStatusKeyedAliasArgs {
  dsl: Dsl;
  plugin: PluginLike;
  opId: string;
  /** e.g. `GetFooResponses` or `GetFooErrors` */
  aliasName: string;
  /** e.g. `GetFooResponse` or `GetFooError` (the indexed-union alias) */
  unionAliasName: string;
  /** Symbol meta `role` for the keyed alias — `'responses'` or `'errors'`. */
  role: 'responses' | 'errors';
  /** Symbol meta `role` for the union alias — `'response'` or `'error'`. */
  unionRole: 'response' | 'error';
  entries: StatusEntry[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  zOutputOfSchema: (schemaName: string) => any;
}

/**
 * Emit `${Op}Responses = { 200: z.output<typeof X>; 201: z.output<typeof Y> }`
 * + `${Op}Response = ${Op}Responses[keyof ${Op}Responses]`. Same shape used
 * for both success ('responses'/'response') and error ('errors'/'error')
 * sides — only the role tags and names differ.
 */
function emitStatusKeyedAlias({
  dsl,
  plugin,
  opId,
  aliasName,
  unionAliasName,
  role,
  unionRole,
  entries,
  zOutputOfSchema
}: EmitStatusKeyedAliasArgs): void {
  const objType = dsl.type.object();
  for (const { status, schemaName } of entries) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    objType.prop(status, (p: any) => p.type(zOutputOfSchema(schemaName)));
  }

  const keyedSymbol = plugin.symbol(aliasName, {
    meta: { category: 'type', resource: 'operation', resourceId: opId, role }
  });
  plugin.node(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dsl.type.alias(keyedSymbol as any) as any).export().type(objType)
  );

  // ${aliasName}[keyof ${aliasName}] — emitted as a string-named type
  // reference. `dsl.type.idx(base, index)` gives indexed-access; the index
  // is `keyof <aliasName>` via dsl.type(...).keyof().
  const unionSymbol = plugin.symbol(unionAliasName, {
    meta: { category: 'type', resource: 'operation', resourceId: opId, role: unionRole }
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const baseRef = dsl.type(keyedSymbol as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const keyofRef = (dsl.type(keyedSymbol as any) as any).keyof();
  plugin.node(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dsl.type.alias(unionSymbol as any) as any).export().type(dsl.type.idx(baseRef, keyofRef))
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Extracts the schema name from an IR schema object.
 * Handles `$ref: '#/components/schemas/Transaction'` → 'Transaction'
 * and `$ref: ['components', 'schemas', 'Transaction']` → 'Transaction'
 */
function extractSchemaName(schema: IR.SchemaObject | undefined): string | null {
  if (!schema) return null;
  const ref = schema.$ref;
  if (!ref) return null;
  if (Array.isArray(ref)) {
    const parts = ref as string[];
    return parts[parts.length - 1] ?? null;
  }
  if (typeof ref === 'string') {
    const parts = ref.split('/');
    return parts[parts.length - 1] ?? null;
  }
  return null;
}
