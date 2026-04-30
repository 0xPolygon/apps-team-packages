/**
 * @polygonlabs/zod-to-openapi-heyapi
 *
 * A `@hey-api/openapi-ts` plugin that sources Zod schemas from a
 * `@asteasolutions/zod-to-openapi` `OpenAPIRegistry` instead of regenerating
 * them from the spec. The plugin owns the public SDK surface: it emits one
 * function per operation, codec-aware on both ends. Behind the scenes it
 * delegates to `@hey-api/sdk`'s emission for the HTTP wiring (URL building,
 * method dispatch, client resolution, response transformer hookup) — the
 * SDK plugin runs as an internal layer, not a user-facing one.
 *
 * On the response side: emit a `z.output<typeof Schema>` type per
 * operation and a `parseAsync` transformer the fetch client runs on every
 * 2xx body. Codec decode (`Int64Codec` wire string → bigint, `IsoDateCodec`
 * wire string → Date) reaches the caller before the value is read.
 *
 * On the request side: for each route whose `request.{params, query, body}`
 * is a registered ZodObject (via `.openapi('Name')` or `register('Name', schema)`),
 * emit a `${Op}Input` type that uses `z.output<typeof Schema>` for the
 * codec-bearing slot and a per-op input transformer that runs
 * `z.encode(schema, value)` before serialisation. Callers pass the runtime
 * shape (`bigint`, `Date`, etc.); the wire format goes onto the URL / query
 * string / body. The case this matters for: `IsoDateCodec` on a path or
 * query parameter, where `String(date)` produces the locale string and the
 * server's parser rejects it.
 *
 * The plugin always emits an SDK wrapper per operation. Codec-bearing ops
 * encode their input; non-codec ops re-bind directly to the upstream SDK
 * function (zero overhead). Either way, the consumer's import surface is
 * uniform — one canonical name per op, in one file.
 *
 * IMPORTANT: list this plugin BEFORE '@hey-api/typescript', and set
 * `includeInEntry: false` on `@hey-api/sdk` so the auto-generated
 * `index.ts` exposes only this plugin's wrappers (not the SDK plugin's
 * raw functions, which would collide on every operation name):
 *
 *   plugins: [
 *     registryPlugin({ ... }) as never,   // ← must be first
 *     '@hey-api/typescript',
 *     '@hey-api/client-fetch',
 *     { name: '@hey-api/sdk', transformer: true, includeInEntry: false }
 *   ]
 *
 * See README.md for usage details and the "what doesn't get handled"
 * constraints.
 */

import type { $, IR } from '@hey-api/openapi-ts';

import { getRefId } from '@asteasolutions/zod-to-openapi';

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
  referenceSymbol?(filter: Record<string, unknown>): any;

  getPlugin?(name: string): { config?: Record<string, unknown> } | undefined;
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

  // Codegen-time audit + identity map source. `schemasFrom` is the module
  // the generated client imports schemas from at runtime; we dynamic-import
  // it here for two purposes:
  //   1. Verify every response `$ref` resolves to a Zod-shaped named export
  //      under the same name (existing audit).
  //   2. Build a `Map<ZodType-instance, exportName>` so input slots can be
  //      resolved by identity rather than by chasing the asteasolutions
  //      `.openapi('Name')` refId through a module-scoped registry.
  let schemasModule: Record<string, unknown>;
  try {
    schemasModule = (await import(schemasFrom)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(buildSchemasFromImportError(schemasFrom, err));
  }

  // Identity index of named exports that look like Zod schemas. Used by
  // `collectInputSchemasFromRegistry` to map an input ZodType reference
  // (held inside `request.params/query/body`) back to a name we can emit
  // as an import binding. If a route uses an inline anonymous schema,
  // it won't appear in this map and the plugin silently skips input-
  // encoding emission for that route — same behaviour as before this
  // change for unregistered slots.
  const exportsByIdentity = new Map<unknown, string>();
  for (const [name, value] of Object.entries(schemasModule)) {
    if (isLikelyZodType(value)) exportsByIdentity.set(value, name);
  }

  const inputsByOpId = collectInputSchemasFromRegistry(registry, exportsByIdentity);

  // Response-side audit: every `$ref` in a route response must resolve to
  // a Zod-shaped named export of `schemasFrom`. Input schemas don't go
  // through this audit — their names ARE export keys (derived from the
  // identity map above), so "exported under that name" is structurally
  // satisfied by construction.
  const responseRefNames = new Set<string>();
  for (const name of collectResponseRefSchemaNames(doc)) {
    if (registrySchemaNames.has(name)) responseRefNames.add(name);
  }

  const errors: string[] = [];
  for (const name of responseRefNames) {
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
      // Pre-flight check: this plugin's correctness depends on two
      // `@hey-api/sdk` config keys. Both default the wrong way for our
      // usage, so check at codegen time rather than letting the failures
      // surface as confusing TS or runtime issues downstream.
      assertSdkPluginCompatible(plugin);

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
        const inputSlots = inputsByOpId.get(opId);
        const hasInputSlots = Boolean(inputSlots && hasAnyInputSlots(inputSlots));

        // Imports — schemas referenced by either response bucket OR the input
        // slots, plus `z` when we'll emit something that references it.
        for (const { schemaName } of [...buckets.success, ...buckets.error]) {
          ensureSchemaImport(schemaName);
        }
        if (inputSlots) {
          for (const name of slotSchemaNames(inputSlots)) ensureSchemaImport(name);
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
        if (distinctSuccessSchemas.length > 0) {
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
        }

        // ── SDK wrapper ───────────────────────────────────────────────────
        // Always emit a wrapper per op — codec-bearing slots get an input
        // transformer and an `${Op}Input` override; non-codec ops get a
        // pass-through that re-binds the upstream SDK function under the
        // canonical name. With `includeInEntry: false` on `@hey-api/sdk`,
        // these wrappers are the only public SDK surface. Consumers see
        // one canonical name per op and can't accidentally import a
        // wire-shaped variant.
        emitSdkWrapper({
          dsl,
          plugin,
          operation,
          opId,
          zSymbol,
          inputSlots: hasInputSlots && inputSlots ? inputSlots : undefined
        });
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

// ── SDK plugin config check ───────────────────────────────────────────────────

/**
 * Assert at codegen time that `@hey-api/sdk` is configured compatibly
 * with this plugin. Two requirements, both of which default the wrong
 * way for our usage — silent misconfig would surface as obscure
 * downstream failures.
 *
 *   - `includeInEntry: false` — this plugin emits wrappers under the
 *     same names as `@hey-api/sdk`'s emissions; without it both land
 *     in the auto-generated `index.ts` and TypeScript fails the
 *     duplicate export.
 *   - `transformer: true` — wires the SDK function's
 *     `responseTransformer` to this plugin's `${opId}Transformer`
 *     symbol. Without it the SDK function is emitted with no
 *     transformer hook, so codec response decode (`Int64Codec` wire
 *     string → bigint, `IsoDateCodec` → Date) silently doesn't run
 *     and the caller receives wire-shaped data while the type
 *     system promises the runtime shape — the worst kind of failure.
 *
 * The error spells out the exact before/after config so the fix is
 * copy-paste, not "what should I look up."
 */
function assertSdkPluginCompatible(plugin: PluginLike): void {
  const sdkPlugin = plugin.getPlugin?.('@hey-api/sdk');
  if (!sdkPlugin) return; // SDK plugin not loaded — nothing to check.
  const config = sdkPlugin.config ?? {};
  const issues: string[] = [];

  if (config['includeInEntry'] !== false) {
    issues.push(
      `  - 'includeInEntry' must be false. This plugin emits a wrapper per ` +
        `operation under the same name as the SDK plugin's emission, so ` +
        `leaving the SDK plugin's emissions in the auto-generated entry ` +
        `barrel produces duplicate exports.`
    );
  }

  // After hey-api's resolveConfig, `transformer` is either `false`,
  // `true` (only briefly, before discovery), or a string identifying
  // the resolved transformer plugin. We want anything truthy.
  if (!config['transformer']) {
    issues.push(
      `  - 'transformer' must be true. Without it, the SDK function is emitted ` +
        `with no responseTransformer wiring, so codec response decode (Int64Codec ` +
        `wire string → bigint, IsoDateCodec → Date) silently doesn't run — callers ` +
        `receive wire-shaped data while the type system promises the runtime shape.`
    );
  }

  if (issues.length === 0) return;

  throw new Error(
    `[zod-to-openapi-heyapi] '@hey-api/sdk' is misconfigured for this plugin:\n` +
      issues.join('\n') +
      `\n\nUpdate your openapi-ts plugins entry from:\n\n` +
      `  { name: '@hey-api/sdk' }\n\n` +
      `to:\n\n` +
      `  { name: '@hey-api/sdk', transformer: true, includeInEntry: false }\n`
  );
}

// ── Input-side codec encoding ─────────────────────────────────────────────────

/** Per-op map: which input slot is bound to which registered schema name. */
interface OpInputSlots {
  params?: string;
  query?: string;
  body?: string;
  headers?: string;
}

function hasAnyInputSlots(slots: OpInputSlots): boolean {
  return Boolean(slots.params || slots.query || slots.body || slots.headers);
}

function slotSchemaNames(slots: OpInputSlots): string[] {
  const out: string[] = [];
  if (slots.params) out.push(slots.params);
  if (slots.query) out.push(slots.query);
  if (slots.body) out.push(slots.body);
  if (slots.headers) out.push(slots.headers);
  return out;
}

/**
 * Whether the SDK plugin's `${Op}Data` declares the given slot as
 * required. Mirrors hey-api's own `hasParameterGroupObjectRequired` for
 * params/query/headers and reads `body.required` for the body slot.
 *
 * Drives whether `${Op}Input` overrides the slot as `slot: T` (required)
 * or `slot?: T` (optional). Without this, callers had to pass
 * `{ query: {} }` for routes whose query schema's fields are all
 * optional — annoying enough that it's worth a few lines of IR walking.
 */
function isSlotRequiredInOpData(
  operation: IR.OperationObject,
  slot: 'path' | 'query' | 'body' | 'headers'
): boolean {
  switch (slot) {
    case 'path': {
      const params = operation.parameters?.path;
      if (!params) return false;
      return Object.values(params).some((p) => p.required === true);
    }
    case 'query': {
      const params = operation.parameters?.query;
      if (!params) return false;
      return Object.values(params).some((p) => p.required === true);
    }
    case 'body':
      return operation.body?.required === true;
    case 'headers': {
      const params = operation.parameters?.header;
      if (!params) return false;
      return Object.values(params).some((p) => p.required === true);
    }
  }
}

/**
 * Walk `registry.definitions` and, for each route, map every input ZodType
 * reference (held inside `request.{params, query, body, headers}`) back to
 * its export name in `schemasFrom` via identity lookup.
 *
 * Identity matters: `.openapi('Name')` and `register('Name', schema)` both
 * return *new* schema instances (asteasolutions clones via
 * `new this.constructor(this._def)` so chained `.openapi(...)` calls don't
 * accumulate). So the user must put the same instance in `request.params`
 * that they export from `schemasFrom`. The natural pattern is:
 *
 *     // schemas.ts
 *     export const BlockNumberPathParams = z
 *       .object({ blockNumber: Int64Codec })
 *       .openapi('BlockNumberPathParams');
 *
 *     // routes/blocks.ts
 *     registry.registerPath({
 *       request: { params: BlockNumberPathParams },  // ← same instance
 *       ...
 *     });
 *
 * Schemas not in `exportsByIdentity` (inline `z.object(...)` literals,
 * post-`register()` instances when the export is the pre-`register()`
 * version, etc.) silently skip input-encoding emission for that route —
 * same behaviour as before for unregistered input slots.
 */
function collectInputSchemasFromRegistry(
  registry: RegistryLike,
  exportsByIdentity: ReadonlyMap<unknown, string>
): Map<string, OpInputSlots> {
  const out = new Map<string, OpInputSlots>();
  const skipWarnings: string[] = [];

  const lookupSlot = (
    schema: unknown,
    opId: string,
    slotKind: 'path' | 'query' | 'body' | 'headers'
  ): string | undefined => {
    if (!schema || typeof schema !== 'object') return undefined;
    if (!isLikelyZodType(schema)) return undefined;
    const name = exportsByIdentity.get(schema);
    if (name) return name;

    // The schema is a real ZodType, but it's not in the identity map of
    // `schemasFrom`'s named exports. This has two flavours:
    //   - Anonymous inline schema (`params: z.object({ id: z.uuid() })`
    //     written directly in the route). Intentional, common, silent.
    //   - The schema has a refId (user chained `.openapi('Name')` or
    //     passed it through `register('Name', ...)`) but the route is
    //     using a different instance from the one that's exported. This
    //     is almost always a user error — the post-`.openapi` /
    //     post-`register` clone diverged from the export. Warn loudly.
    //
    // Detect "has a refId" via asteasolutions's public `getRefId`.
    // Diagnostic-only: if the cross-package metadata registry isn't
    // shared (broken pnpm dedup), `getRefId` returns undefined and we
    // silently skip — same outcome as an anonymous inline schema.
    // The user still notices via the runtime symptom (wrong wire
    // shape, server rejection) — the warning is the nice-to-have.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const refId = getRefId(schema as any);
    if (refId) {
      skipWarnings.push(
        `[zod-to-openapi-heyapi] operation '${opId}' uses a non-exported schema in request.${slotKind} ` +
          `that carries refId '${refId}' — input encoding will be skipped for this slot. ` +
          `This usually means the route is using the post-.openapi('${refId}') / post-register('${refId}', ...) ` +
          `clone but '${refId}' is exported from your schemasFrom module under a different instance. ` +
          `Pick one source for the schema (the export) and use it everywhere.`
      );
    }
    return undefined;
  };

  for (const def of registry.definitions) {
    if (!def || def.type !== 'route') continue;
    const route = def.route ?? {};
    const opId: string | undefined = route.operationId;
    if (!opId) continue;
    const request = route.request;
    if (!request) continue;

    const slots: OpInputSlots = {};
    const params = lookupSlot(request.params, opId, 'path');
    if (params) slots.params = params;
    const query = lookupSlot(request.query, opId, 'query');
    if (query) slots.query = query;

    // headers is `RouteParameter | ZodType[]` — only handle the
    // single-schema case to keep this iteration focused on params/query/body.
    if (request.headers && !Array.isArray(request.headers)) {
      const headers = lookupSlot(request.headers, opId, 'headers');
      if (headers) slots.headers = headers;
    }

    // body.content[mediaType].schema is the request body Zod schema.
    if (request.body?.content) {
      for (const mt of Object.values(
        request.body.content as Record<string, { schema?: unknown } | undefined>
      )) {
        const body = lookupSlot(mt?.schema, opId, 'body');
        if (body) {
          slots.body = body;
          break;
        }
      }
    }

    if (hasAnyInputSlots(slots)) out.set(opId, slots);
  }

  // Emit warnings via console.warn so they reach the developer's
  // terminal during `openapi-ts`. One per misaligned slot — this is the
  // user-error case, not the silent-skip-anonymous-inline case.
  for (const msg of skipWarnings) {
    console.warn(msg);
  }

  return out;
}

interface EmitSdkWrapperArgs {
  dsl: Dsl;
  plugin: PluginLike;
  /**
   * The hey-api IR operation. Used to determine per-slot optionality in
   * `${Op}Data` (which `${Op}Input` mirrors via `Omit<${Op}Data, slots> &
   * { slot[?]: <runtime> }`).
   */
  operation: IR.OperationObject;
  opId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  zSymbol: any;
  /**
   * When defined, the op has at least one registered input schema and the
   * wrapper will encode that slot via `z.encode` before delegating. When
   * undefined, the wrapper is a thin re-binding of the upstream SDK
   * function (zero overhead, identical type signature).
   */
  inputSlots: OpInputSlots | undefined;
}

/**
 * Emit the per-op SDK wrapper that becomes the canonical public function
 * for this operation:
 *
 *   - For ops with a registered input schema: emit `${Op}Input`,
 *     `${opId}InputTransformer`, and a `${opId}` async wrapper that runs
 *     `z.encode(schema, value)` on each registered slot before delegating.
 *   - For ops without a registered input schema: emit `${opId}` as a
 *     direct re-binding of the upstream SDK function — same call
 *     signature, no microtask overhead, the only purpose is to make the
 *     auto-generated `index.ts` re-export a single canonical name.
 *
 * Pre-condition: `includeInEntry: false` is set on `@hey-api/sdk` so the
 * SDK plugin's same-named emissions don't collide with these wrappers in
 * the entry barrel.
 */
function emitSdkWrapper({
  dsl,
  plugin,
  operation,
  opId,
  zSymbol,
  inputSlots
}: EmitSdkWrapperArgs): void {
  // Cross-file references — the SDK plugin and the typescript plugin emit
  // these symbols. `referenceSymbol` creates a stub now and resolves it
  // when those plugins register their nodes later in the codegen run, so
  // forward references work.
  const referenceSymbol = plugin.referenceSymbol;
  if (!referenceSymbol) return;

  const sdkSymbol = referenceSymbol.call(plugin, {
    category: 'sdk',
    resource: 'operation',
    resourceId: opId,
    tool: 'sdk'
  });

  const wrapperSymbol = plugin.symbol(opId, {
    meta: { category: 'sdk-wrapper', resource: 'operation', resourceId: opId }
  });

  // Pass-through: no codec-bearing slots, no encoding to do. Re-bind the
  // SDK function under the canonical name. Hey-api auto-aliases the
  // imported binding (`getFoo as getFoo2` from `./sdk.gen.ts`) so the
  // local name is collision-free.
  if (!inputSlots) {
    plugin.node(
      dsl
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .const(wrapperSymbol as any)
        .export()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .assign(dsl(sdkSymbol as any))
    );
    return;
  }

  type SlotKey = 'path' | 'query' | 'body' | 'headers';
  const slotEntries: ReadonlyArray<readonly [SlotKey, string]> = (
    [
      ['path', inputSlots.params],
      ['query', inputSlots.query],
      ['body', inputSlots.body],
      ['headers', inputSlots.headers]
    ] as const
  ).filter((entry): entry is readonly [SlotKey, string] => entry[1] !== undefined);

  const opDataSymbol = referenceSymbol.call(plugin, {
    category: 'type',
    resource: 'operation',
    resourceId: opId,
    role: 'data',
    tool: 'typescript'
  });
  const optionsSymbol = referenceSymbol.call(plugin, {
    category: 'type',
    resource: 'client-options',
    tool: 'sdk'
  });

  // ── ${Op}Input type ──────────────────────────────────────────────────────
  //   Omit<${Op}Data, slot1 | slot2 | ...> & { slot1: <T1>; slot2?: <T2>; ... }
  //
  // Per-slot optionality is taken from the IR: a slot is required iff the
  // SDK plugin's `${Op}Data` declares it required, which it does iff at
  // least one of the slot's underlying parameters is required (for
  // params/query/headers) or the request body is `required: true` (for
  // body). Same call hey-api uses internally — see `hasParameterGroupObjectRequired`.
  // So callers don't need to pass `{ query: {} }` for routes whose query
  // schema has only optional fields; they can omit the slot entirely.
  const overrideObj = dsl.type.object();
  for (const [slot, schemaName] of slotEntries) {
    const schemaSym = plugin.querySymbol({
      category: 'schema',
      tool: 'zod',
      resource: 'registry',
      name: schemaName
    });
    if (!schemaSym) continue;
    const slotIsRequired = isSlotRequiredInOpData(operation, slot);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (overrideObj as any).prop(slot, (p: any) =>
      p.required(slotIsRequired).type(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (dsl.type(zSymbol as any).attr('output') as any).generic(dsl.type.query(dsl(schemaSym)))
      )
    );
  }

  // Closure so each call returns a fresh DSL node — re-using one node has
  // produced double-rendered output in some DSL paths.
  const slotKeyUnion = (): unknown =>
    slotEntries.length === 1
      ? dsl.type.literal(slotEntries[0]![0])
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (dsl.type.or as (...args: any[]) => unknown)(
          ...slotEntries.map(([slot]) => dsl.type.literal(slot))
        );

  const omitOpData = dsl
    .type('Omit')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .generic(dsl.type(opDataSymbol as any))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .generic(slotKeyUnion() as any);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inputTypeExpr = (dsl.type.and as (...args: any[]) => unknown)(omitOpData, overrideObj);

  const inputSymbol = plugin.symbol(`${capitalizeFirst(opId)}Input`, {
    meta: { category: 'type', resource: 'operation', resourceId: opId, role: 'input' }
  });
  plugin.node(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dsl.type.alias(inputSymbol as any) as any).export().type(inputTypeExpr)
  );

  // ── ${opId}InputTransformer ──────────────────────────────────────────────
  // Per-slot, conditional spread:
  //   ...(input.<slot> !== undefined
  //         ? { <slot>: await z.encode(<Schema>, input.<slot>) }
  //         : {})
  //
  // Conditional handles optional slots: if the user didn't provide
  // `input.query` for a route whose Data declared it optional, skip the
  // encode (z.encode on undefined would throw against a required object
  // schema). For required slots the conditional is dead code — TS would
  // have rejected `undefined` at the call site — but the runtime cost
  // is a single property check, so we don't bother specialising.
  //
  // `async` on the function declaration means callers always receive a
  // Promise, regardless of whether `z.encode` is sync (number-flavoured
  // codecs) or async (codecs that wrap async transforms). Awaiting a
  // non-promise resolves immediately, so the sync path pays one tick of
  // microtask overhead — negligible compared to the network call.
  const transformerObjBody = dsl.object();
  for (const [slot, schemaName] of slotEntries) {
    const schemaSym = plugin.querySymbol({
      category: 'schema',
      tool: 'zod',
      resource: 'registry',
      name: schemaName
    });
    if (!schemaSym) continue;

    const encodedSlotObject = dsl.object();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (encodedSlotObject as any).prop(
      slot,
      dsl(zSymbol)
        .attr('encode')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .call(dsl(schemaSym as any), dsl('input').attr(slot))
        .await()
    );

    const conditionalSlot = dsl
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .ternary(dsl('input').attr(slot).neq(dsl.id('undefined')) as any)
      .do(encodedSlotObject)
      .otherwise(dsl.object());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transformerObjBody as any).spread(conditionalSlot);
  }
  // Input transformer's parameter is `Pick<${Op}Input, slot1 | slot2 | ...>`
  // — just the slots it actually reads. Using the full ${Op}Input would
  // require `url`, but the SDK's `Options<TData>` strips `url` from TData
  // (the SDK function provides it as a literal), so the wrapper couldn't
  // pass `options` directly to the transformer. Picking only the read
  // slots keeps the call site clean.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inputPickType = (dsl as any)
    .type('Pick')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .generic(dsl.type(inputSymbol as any))
    .generic(slotKeyUnion());

  const inputTransformerSymbol = plugin.symbol(`${opId}InputTransformer`, {
    meta: {
      category: 'transform',
      resource: 'operation',
      resourceId: opId,
      role: 'input'
    }
  });
  plugin.node(
    dsl
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .const(inputTransformerSymbol as any)
      .export()
      .assign(
        dsl
          .func()
          .async()
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .param('input', (p: any) => p.type(inputPickType))
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .do((transformerObjBody as any).return())
      )
  );

  // ── ${opId} SDK wrapper ──────────────────────────────────────────────────
  // Same name as the SDK plugin's emission. Consumers should set
  // `includeInEntry: false` on `@hey-api/sdk` to avoid a duplicate-export
  // collision in the auto-generated `index.ts`.
  //
  // Signature:
  //   <ThrowOnError extends boolean = false>(options: Options<${Op}Input, ThrowOnError>)
  //
  // The body spreads the input transformer's encoded output over `options`,
  // so the wire-shaped slot values replace their runtime counterparts before
  // the SDK function runs the request. The result type is whatever the SDK
  // function returns — preserved by passing `ThrowOnError` straight through.
  // (Wrapper symbol was registered above the pass-through guard.)

  // Options<${Op}Input, ThrowOnError>
  const optionsTypeExpr = dsl
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .type(optionsSymbol as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .generic(dsl.type(inputSymbol as any))
    .generic('ThrowOnError');

  // The merged options literal: { ...options, ...transformed }. Cast to
  // the SDK's wire-shaped Options<${Op}Data> on the way out — the
  // structural check fails because the runtime path/query/body slots
  // (from `options`) and the encoded slots (from `transformed`) are
  // unioned in the merged type, but at runtime the second spread
  // overrides the first, so the wire shape is what actually goes to
  // the SDK function. Cast tells TS what the runtime guarantees.
  const mergedOptions = dsl.object();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mergedOptions as any).spread('options');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mergedOptions as any).spread('transformed');
  const sdkOptionsTypeExpr = dsl
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .type(optionsSymbol as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .generic(dsl.type(opDataSymbol as any))
    .generic('ThrowOnError');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mergedOptionsCast = dsl.as(mergedOptions as any, sdkOptionsTypeExpr as any);

  // The wrapper's `options` param is optional iff `${Op}Data` has no
  // required slot — same rule the SDK plugin uses via
  // `hasOperationDataRequired`. So a route with all-optional slots
  // (e.g. listMessages with only an optional query) accepts a no-arg
  // call: `listMessages()`. Routes with required slots (like a path
  // param) still demand `options`: `lookupBlock({ path: {...} })`.
  const optionsRequired =
    isSlotRequiredInOpData(operation, 'path') ||
    isSlotRequiredInOpData(operation, 'query') ||
    isSlotRequiredInOpData(operation, 'body') ||
    isSlotRequiredInOpData(operation, 'headers');

  plugin.node(
    dsl
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .const(wrapperSymbol as any)
      .export()
      .assign(
        dsl
          .func()
          .async()
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .generic('ThrowOnError', (g: any) => g.extends('boolean').default(false))
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .param('options', (p: any) => p.required(optionsRequired).type(optionsTypeExpr))
          .do(
            // `options ?? {}` when the parameter is optional — guards
            // the transformer (which extracts `input.<slot>`) against
            // undefined. Spread of undefined elsewhere is a no-op so
            // `{ ...options, ...transformed }` is fine without the
            // coalesce.
            dsl
              .const('transformed')

              .assign(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                dsl(inputTransformerSymbol as any)
                  .call(
                    optionsRequired
                      ? 'options'
                      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        (dsl('options').coalesce(dsl.object()) as any)
                  )
                  .await()
              ),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (dsl(sdkSymbol as any).call(mergedOptionsCast) as any).await().return()
          )
      )
  );
}
