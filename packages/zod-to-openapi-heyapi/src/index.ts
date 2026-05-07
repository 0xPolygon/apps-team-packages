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

import type { $, IR, UserConfig } from '@hey-api/openapi-ts';

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
  /**
   * When `true`, emit codec-aware TanStack Query options factories
   * (`${opId}Options` and `${opId}QueryKey`) **only for operations with a
   * registered input schema** (codec ops). Non-codec ops are deliberately
   * skipped — they're owned by the upstream `@tanstack/react-query` plugin,
   * which gets their typing right because there are no codec input slots
   * to bridge.
   *
   * The intended composition is: this plugin emits factories for codec ops,
   * the upstream plugin emits factories for everything else, both use the
   * same names (`${opId}Options` / `${opId}QueryKey`), and the upstream
   * plugin is told not to emit for codec ops via a parser-level
   * `isQuery` hook returning `false` for those operation ids. Use
   * {@link defineRegistryClientConfig} to wire all of that automatically.
   *
   * Why this exists: the upstream plugin types its factories against the
   * **wire**-shape `${Op}Data`, so an operation with a codec input slot
   * (`{ blockNumber: bigint }` runtime → `string` wire) is forced to call
   * the factory with wire types, defeating the codec round-trip the SDK
   * wrapper provides on the request side. Our factories type against
   * `${Op}Input` (codec runtime types) and pre-encode the codec slots into
   * the queryKey so a) the queryFn can pass them straight to the raw SDK
   * function and b) the default `JSON.stringify`-based queryKey hash stays
   * stable for codec types that don't serialise cleanly (e.g. `bigint`).
   * Output-codec ops still work — the response transformer the SDK plugin
   * wires up runs on the queryFn's return value before the data reaches the
   * caller.
   *
   * Adds a runtime peer-dependency on `@tanstack/react-query` for
   * consumers.
   */
  tanstackReactQuery?: boolean;
}

// ── Plugin factory ─────────────────────────────────────────────────────────────

export async function registryPlugin({
  registry,
  schemasFrom,
  generatorClass,
  $: dsl,
  tanstackReactQuery = false
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

      // Tanstack scaffolding (queryOptions value, DefaultError type, the
      // `QueryKey<TOptions>` alias, and the shared createQueryKey helper) is
      // emitted lazily on first use — operations with no 2xx response don't
      // get a factory, and a registry that happens to consist entirely of
      // those (errors-only ops) shouldn't import @tanstack/react-query.
      let tanstackScaffolded = false;
      const tanstackState: TanstackScaffoldState = {};
      const ensureTanstackScaffold = (): TanstackScaffoldState | undefined => {
        if (!tanstackReactQuery) return undefined;
        if (tanstackScaffolded) return tanstackState;
        tanstackScaffolded = true;
        scaffoldTanstack({ dsl, plugin, state: tanstackState });
        return tanstackState;
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

        // ── Transformers ─────────────────────────────────────────────────
        // Two flavours, structurally identical:
        //
        //   - Success: client-fetch invokes `responseTransformer` on every
        //     2xx response, no status dispatch — when multiple distinct
        //     2xx schemas exist the transformer accepts any of them via
        //     `z.union(...)`. Wired by `@hey-api/sdk` (it reads the
        //     `'transformer'` tag this plugin advertises).
        //   - Error: not auto-wired. Hey-api's fetch client never runs
        //     transformers on non-2xx bodies, so error responses arrive
        //     wire-shape and the SDK wrapper has to call `parseAsync`
        //     itself on the way out. Emitted here, consumed below in
        //     `emitSdkWrapper`. Same union-of-schemas pattern keeps the
        //     decode honest for ops that declare per-status error
        //     schemas of different shapes.
        const distinctSuccessSchemas = uniqueSchemaNames(buckets.success);
        if (distinctSuccessSchemas.length > 0) {
          emitParseTransformer({
            dsl,
            plugin,
            zSymbol,
            opId,
            schemaNames: distinctSuccessSchemas,
            transformerName: `${opId}Transformer`,
            role: 'response',
            zOutputOfSchema
          });
        }

        const distinctErrorSchemas = uniqueSchemaNames(buckets.error);
        const errorTransformerSymbol =
          distinctErrorSchemas.length > 0
            ? emitParseTransformer({
                dsl,
                plugin,
                zSymbol,
                opId,
                schemaNames: distinctErrorSchemas,
                transformerName: `${opId}ErrorTransformer`,
                role: 'error',
                zOutputOfSchema
              })
            : undefined;

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
          inputSlots: hasInputSlots && inputSlots ? inputSlots : undefined,
          errorTransformerSymbol
        });

        // ── TanStack Query factories ──────────────────────────────────────
        // Emit factories only for codec ops — operations with at least one
        // registered input schema. Non-codec ops are deliberately skipped:
        // the upstream `@tanstack/react-query` plugin types factories
        // against the wire shape `${Op}Data`, which is correct for ops
        // without codec slots (no input encoding to bridge). Letting it
        // own non-codec ops keeps that plugin canonical for queryKey
        // identity, infinite queries, and any feature it adds later.
        //
        // Errors-only ops (no 2xx response) are skipped regardless of
        // codec status — there's no Response type to parameterise
        // queryOptions with, and a query that always errors isn't a
        // useful surface. The upstream plugin makes the same call.
        //
        // Composition with upstream is enforced at the parser level via
        // `parser.hooks.operations.isQuery`: codec op ids return false
        // there, so the upstream plugin skips them. Our factory and
        // upstream's never collide on the same name.
        // {@link defineRegistryClientConfig} wires the hook automatically.
        if (tanstackReactQuery && hasInputSlots && inputSlots && buckets.success.length > 0) {
          const scaffold = ensureTanstackScaffold();
          if (scaffold) {
            emitTanstackQueryFactory({
              dsl,
              plugin,
              operation,
              opId,
              hasErrorBucket: buckets.error.length > 0,
              inputSlots,
              scaffold
            });
          }
        }
      });
    }
  };
}

// ── Config factory ────────────────────────────────────────────────────────────

/** Options for {@link defineRegistryClientConfig}. */
export interface DefineRegistryClientConfigOptions {
  /**
   * The OpenAPIRegistry whose routes the generated client will cover.
   * Same registry passed to {@link registryPlugin} — used here both for
   * the plugin and (when tanstack is wired) to build the parser hook
   * that excludes codec ops from the upstream `@tanstack/react-query`
   * plugin's emission.
   */
  registry: RegistryLike;
  /**
   * Module specifier the generated client imports Zod schemas from at
   * runtime. See {@link RegistryPluginOptions.schemasFrom} for resolution
   * rules — same constraints apply.
   */
  schemasFrom: string;
  /**
   * The OpenAPI spec input. Accepts every form openapi-ts accepts —
   * URL string, filesystem path, or a parsed spec object. Pass through
   * unmodified to `createClient({ input })`.
   */
  input: UserConfig['input'];
  /**
   * Output directory configuration. Pass either a path string (the
   * common case) or the full `UserConfig['output']` object for
   * advanced needs (custom format, casing, etc.).
   */
  output: UserConfig['output'];
  /**
   * When `true`, wires the upstream `@tanstack/react-query` plugin into
   * the generated config AND emits codec-aware factories from
   * {@link registryPlugin} for codec ops only. A parser-level
   * `isQuery: false` hook on codec ops keeps the upstream plugin from
   * double-emitting the same names.
   *
   * Adds an optional runtime peer-dependency on
   * `@tanstack/react-query`. Leave unset (or `false`) for backends and
   * SDK packages that don't pull tanstack into their bundle.
   *
   * @default false
   */
  tanstackReactQuery?: boolean;
  /**
   * Pass-through for the openapi-ts `parser` config (filters, transforms,
   * pagination, custom hooks). The factory's own `isQuery` hook composes
   * with whatever you provide here — yours runs after ours, so you can
   * still classify non-codec ops however you like. Codec ops always
   * resolve to `false` to keep upstream tanstack from claiming them.
   */
  parser?: UserConfig['parser'];
}

/**
 * Build a complete `openapi-ts` UserConfig wired for the registry-driven
 * codec pipeline. This is the canonical entry point — prefer it over
 * composing {@link registryPlugin} into a plugin list by hand.
 *
 * The factory locks in:
 *
 *   - {@link registryPlugin} ahead of `@hey-api/typescript` so the
 *     response-type symbols register first.
 *   - `@hey-api/client-fetch` as the HTTP client.
 *   - `@hey-api/sdk` with `transformer: true` and `includeInEntry: false`
 *     — both required for the codec round-trip to fire and for the
 *     entry barrel to expose only this plugin's wrappers.
 *
 * When `tanstackReactQuery: true`, it additionally:
 *
 *   - Adds `'@tanstack/react-query'` to the plugin list.
 *   - Installs a `parser.hooks.operations.isQuery` hook that returns
 *     `false` for every operation id with a registered input schema, so
 *     the upstream tanstack plugin skips those — this plugin emits them
 *     instead with codec-aware typing.
 *
 * @example
 * ```ts
 * import { defineRegistryClientConfig } from '@polygonlabs/zod-to-openapi-heyapi';
 * import { registry } from './registry';
 *
 * export default await defineRegistryClientConfig({
 *   registry,
 *   schemasFrom: '@my-org/api-schemas',
 *   input: './openapi.json',
 *   output: './src/generated',
 *   tanstackReactQuery: true
 * });
 * ```
 */
export async function defineRegistryClientConfig(
  opts: DefineRegistryClientConfigOptions
): Promise<UserConfig> {
  // Late-import the resolution-fragile passthroughs so callers don't have
  // to pass `$` and `OpenApiGeneratorV3` themselves — half the point of
  // having a factory is to hide these.
  const [{ $: dsl }, { OpenApiGeneratorV3 }] = await Promise.all([
    import('@hey-api/openapi-ts'),
    import('@asteasolutions/zod-to-openapi')
  ]);

  const tanstack = opts.tanstackReactQuery ?? false;

  const pluginConfig = await registryPlugin({
    registry: opts.registry,
    schemasFrom: opts.schemasFrom,
    generatorClass: OpenApiGeneratorV3 as unknown as GeneratorClass,
    $: dsl,
    tanstackReactQuery: tanstack
  });

  const plugins: UserConfig['plugins'] = [
    pluginConfig as never,
    '@hey-api/typescript',
    '@hey-api/client-fetch',
    { name: '@hey-api/sdk', transformer: true, includeInEntry: false },
    ...(tanstack ? (['@tanstack/react-query'] as const) : [])
  ];

  // Build the parser hook only when tanstack is wired. Skipped otherwise
  // so non-tanstack consumers don't pay for the schemasFrom dynamic
  // import a second time and their `isQuery` resolution stays default.
  let parser: UserConfig['parser'] = opts.parser;
  if (tanstack) {
    const codecOpIds = await collectCodecOpIds(opts.registry, opts.schemasFrom);
    const userIsQuery = opts.parser?.hooks?.operations?.isQuery;
    parser = {
      ...opts.parser,
      hooks: {
        ...opts.parser?.hooks,
        operations: {
          ...opts.parser?.hooks?.operations,
          isQuery: (op) => {
            if (codecOpIds.has(op.id)) return false;
            return userIsQuery ? userIsQuery(op) : undefined;
          }
        }
      }
    };
  }

  return {
    input: opts.input,
    output: opts.output,
    plugins,
    ...(parser ? { parser } : {})
  };
}

/**
 * Walk the registry the same way {@link registryPlugin} does and return
 * the set of operation ids that have at least one registered input
 * schema (== "codec op", in the sense that we'll emit a factory for it).
 *
 * Duplicates the input collection the plugin does internally — fine for
 * codegen-time work and keeps the two paths independent so refactoring
 * one doesn't have to touch the other.
 */
async function collectCodecOpIds(
  registry: RegistryLike,
  schemasFrom: string
): Promise<ReadonlySet<string>> {
  let schemasModule: Record<string, unknown>;
  try {
    schemasModule = (await import(schemasFrom)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(buildSchemasFromImportError(schemasFrom, err));
  }
  const exportsByIdentity = new Map<unknown, string>();
  for (const [name, value] of Object.entries(schemasModule)) {
    if (isLikelyZodType(value)) exportsByIdentity.set(value, name);
  }
  const inputs = collectInputSchemasFromRegistry(registry, exportsByIdentity);
  return new Set(inputs.keys());
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
   * undefined and `errorTransformerSymbol` is also undefined, the wrapper
   * is a thin re-binding of the upstream SDK function (zero overhead,
   * identical type signature).
   */
  inputSlots: OpInputSlots | undefined;
  /**
   * Symbol of the per-op `${opId}ErrorTransformer` if one was emitted
   * (i.e. the op declared at least one error schema). When defined, the
   * wrapper runs `parseAsync` on `result.error` so the runtime shape
   * matches the codec-aware `${Op}Error` type the plugin emits — closing
   * the long-standing type/runtime divergence on the error path. When
   * undefined, no error decoding is wired.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  errorTransformerSymbol: any;
}

interface EmitParseTransformerArgs {
  dsl: Dsl;
  plugin: PluginLike;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  zSymbol: any;
  opId: string;
  /** Distinct schema names from the bucket, in spec order. */
  schemaNames: ReadonlyArray<string>;
  /** Emitted symbol name — `${opId}Transformer` or `${opId}ErrorTransformer`. */
  transformerName: string;
  /** Symbol meta `role` — drives downstream lookup. */
  role: 'response' | 'error';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  zOutputOfSchema: (schemaName: string) => any;
}

/**
 * Emit `export const ${transformerName} = async (data: unknown):
 * Promise<...> => Schema.parseAsync(data)` (single-schema form) or the
 * `z.union([A, B, ...]).parseAsync(data)` form when the bucket carries
 * multiple distinct schemas.
 *
 * Identical structurally for both response and error transformers — the
 * only differences are the symbol name, the `role` meta tag, and the set
 * of schemas in the union.
 *
 * Returns the registered symbol so the SDK wrapper can reference it.
 */
function emitParseTransformer({
  dsl,
  plugin,
  zSymbol,
  opId,
  schemaNames,
  transformerName,
  role,
  zOutputOfSchema
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}: EmitParseTransformerArgs): any {
  const schemaSymbols = schemaNames.map((schemaName) => {
    const sym = plugin.querySymbol({
      category: 'schema',
      tool: 'zod',
      resource: 'registry',
      name: schemaName
    });
    if (!sym) throw new Error(`schema symbol missing for ${schemaName}`);
    return { schemaName, sym };
  });

  const transformerSymbol = plugin.symbol(transformerName, {
    meta: {
      category: 'transform',
      resource: 'operation',
      resourceId: opId,
      role
    }
  });

  // Body — either `Schema.parseAsync(data)` or
  // `z.union([A, B, ...]).parseAsync(data)`.
  const transformerBody =
    schemaSymbols.length === 1
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dsl(schemaSymbols[0]!.sym as any)
      : dsl(zSymbol)
          .attr('union')
          .call(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            dsl.array(...schemaSymbols.map(({ sym }) => dsl(sym) as any)) as any
          );

  // Return type — `Promise<z.output<typeof Schema>>` or
  // `Promise<z.output<typeof A> | z.output<typeof B> | ...>`.
  const outputs = schemaNames.map((s) => zOutputOfSchema(s));
  const unionType =
    outputs.length === 1
      ? outputs[0]
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (dsl.type.or as (...args: any[]) => unknown)(...outputs);

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
            dsl.type('Promise').generic(unionType as any) as any
          )
          .do(transformerBody.attr('parseAsync').call('data').await().return())
      )
  );

  return transformerSymbol;
}

/**
 * Emit the per-op SDK wrapper that becomes the canonical public function
 * for this operation. The wrapper has three flavours, picked by what the
 * op actually needs:
 *
 *   - **Re-bind** (no input schemas, no error schemas): emit
 *     `export const ${opId} = ${opId}2` — same call signature as the
 *     upstream SDK function, zero overhead, just present so the auto-
 *     generated `index.ts` re-exports a single canonical name.
 *   - **Input encoding only**: emit `${Op}Input`, `${opId}InputTransformer`,
 *     and an async wrapper that runs `z.encode(schema, value)` on each
 *     registered slot before delegating. Wire shape goes to the SDK
 *     function regardless of what the caller passed.
 *   - **Error decoding** (with or without input encoding): wrap the SDK
 *     call in a try/catch so the wrapper can `parseAsync` the error body
 *     against the registered error schema(s). `result.error` from the
 *     `throwOnError: false` path gets decoded in-place; the
 *     `throwOnError: true` path catches the thrown wire-shape body,
 *     decodes it, and re-throws the typed result. If `parseAsync` fails
 *     (response doesn't match any registered error schema — server bug
 *     or network-level error surfaced through the catch), the original
 *     wire-shape value passes through unchanged: better to leak a small
 *     type/runtime gap on malformed responses than to throw `ZodError`s
 *     into a caller that explicitly asked for non-throwing behaviour.
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
  inputSlots,
  errorTransformerSymbol
}: EmitSdkWrapperArgs): void {
  // Cross-file references — the SDK plugin and the typescript plugin emit
  // these symbols. `referenceSymbol` creates a stub now and resolves it
  // when those plugins register their nodes later in the codegen run, so
  // forward references work. If hey-api ever drops `referenceSymbol` or
  // we somehow run without it loaded, fail loudly rather than silently
  // emit nothing — a wrapper-less op produces a `index.ts` that's
  // missing exports, which is much harder to debug than a codegen-time
  // throw.
  const referenceSymbol = plugin.referenceSymbol;
  if (!referenceSymbol) {
    throw new Error(
      `[zod-to-openapi-heyapi] plugin.referenceSymbol is not available. ` +
        `Cannot emit SDK wrapper for '${opId}'. This likely means the hey-api ` +
        `version is incompatible — check the @hey-api/openapi-ts peer-dep range.`
    );
  }

  const sdkSymbol = referenceSymbol.call(plugin, {
    category: 'sdk',
    resource: 'operation',
    resourceId: opId,
    tool: 'sdk'
  });

  const wrapperSymbol = plugin.symbol(opId, {
    meta: { category: 'sdk-wrapper', resource: 'operation', resourceId: opId }
  });

  // Cross-file references used regardless of which wrapper flavour we emit.
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

  // Pass-through: nothing for the wrapper to do. Emit a typed arrow
  // `async (options) => sdkFn(options)` rather than a direct re-bind
  // (`const getX = getX2`) so `getX.name === 'getX'` — the previous
  // re-bind kept the auto-aliased `getX2` as the function's `.name`,
  // breaking telemetry / logging that introspects the canonical name.
  // The arrow adds one stack frame and one allocation per call, which
  // is negligible next to the network round-trip; the public surface
  // (call signature, return shape, throwOnError narrowing) is
  // identical to the upstream SDK function because we forward the
  // generic and the typed options through unchanged.
  if (!inputSlots && !errorTransformerSymbol) {
    const passthroughOptionsType = dsl
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .type(optionsSymbol as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .generic(dsl.type(opDataSymbol as any))
      .generic('ThrowOnError');
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
            .param('options', (p: any) => p.required(optionsRequired).type(passthroughOptionsType))
            .do(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (dsl(sdkSymbol as any).call('options') as any).await().return()
            )
        )
    );
    return;
  }

  // ── ${Op}Input + ${opId}InputTransformer (codec-input ops only) ────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let inputSymbol: any | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let inputTransformerSymbol: any | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mergedOptionsCast: any | undefined;
  if (inputSlots) {
    type SlotKey = 'path' | 'query' | 'body' | 'headers';
    const slotEntries: ReadonlyArray<readonly [SlotKey, string]> = (
      [
        ['path', inputSlots.params],
        ['query', inputSlots.query],
        ['body', inputSlots.body],
        ['headers', inputSlots.headers]
      ] as const
    ).filter((entry): entry is readonly [SlotKey, string] => entry[1] !== undefined);

    // ${Op}Input = Omit<${Op}Data, slot1 | slot2 | …> & { slot1: <T1>; slot2?: <T2>; … }
    //
    // Per-slot optionality is taken from the IR: a slot is required iff the
    // SDK plugin's `${Op}Data` declares it required, which it does iff at
    // least one of the slot's underlying parameters is required (for
    // params/query/headers) or the request body is `required: true` (for
    // body). Same call hey-api uses internally — see
    // `hasParameterGroupObjectRequired`. So callers don't need to pass
    // `{ query: {} }` for routes whose query schema has only optional
    // fields; they can omit the slot entirely.
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

    inputSymbol = plugin.symbol(`${capitalizeFirst(opId)}Input`, {
      meta: { category: 'type', resource: 'operation', resourceId: opId, role: 'input' }
    });
    plugin.node(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dsl.type.alias(inputSymbol as any) as any).export().type(inputTypeExpr)
    );

    // ${opId}InputTransformer
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

    inputTransformerSymbol = plugin.symbol(`${opId}InputTransformer`, {
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

    // The merged options literal: { ...options, ...transformed }. Cast to
    // the SDK's wire-shaped Options<${Op}Data, ThrowOnError> on the way
    // out — the structural check fails because the runtime
    // path/query/body slots (from `options`) and the encoded slots (from
    // `transformed`) are unioned in the merged type, but at runtime the
    // second spread overrides the first, so the wire shape is what
    // actually goes to the SDK function. Cast tells TS what the runtime
    // guarantees, and pinning ThrowOnError preserves the literal
    // narrowing through the cast (without it `Options<TData>` defaults
    // ThrowOnError to `boolean` and the SDK function's return type
    // widens, breaking downstream callers).
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
    mergedOptionsCast = dsl.as(mergedOptions as any, sdkOptionsTypeExpr as any);
  }

  // ── ${opId} SDK wrapper ──────────────────────────────────────────────────
  // Same name as the SDK plugin's emission. Consumers must set
  // `includeInEntry: false` on `@hey-api/sdk` to avoid a duplicate-export
  // collision in the auto-generated `index.ts` — `defineRegistryClientConfig`
  // wires this automatically.
  //
  // Signature:
  //   <ThrowOnError extends boolean = false>(options[?]: Options<${Op}Input | ${Op}Data, ThrowOnError>)
  //
  // Param type is `${Op}Input` for codec-input ops, `${Op}Data` otherwise.
  // The body conditionally:
  //   1. Runs `${opId}InputTransformer` to encode codec slots (codec ops only).
  //   2. Wraps the SDK call in a try/catch that decodes thrown error
  //      bodies via `${opId}ErrorTransformer` (ops with error schemas).
  //   3. Decodes `result.error` in-place after the SDK call returns
  //      (ops with error schemas, throwOnError: false path).
  //
  // Steps 2 and 3 close the type/runtime gap on the error path — the
  // `${Op}Error` types claim `z.output<typeof ErrSchema>` and the wrapper
  // makes the runtime match. `parseAsync` failures (response doesn't fit
  // any registered error schema) leave the wire-shape value untouched
  // rather than throwing, so non-throwing callers keep their no-throw
  // contract on malformed responses.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapperOptionsTypeArg: any = inputSymbol ?? opDataSymbol;
  const optionsTypeExpr = dsl
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .type(optionsSymbol as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .generic(dsl.type(wrapperOptionsTypeArg as any))
    .generic('ThrowOnError');

  // SDK call expression — identical at runtime regardless of input
  // encoding, only the argument shape changes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdkCallArg: any = mergedOptionsCast ?? dsl.id('options');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdkCallExpr = (dsl(sdkSymbol as any).call(sdkCallArg) as any).await();

  const bodyStatements: unknown[] = [];

  // Step 1 — input transform.
  if (inputTransformerSymbol) {
    bodyStatements.push(
      dsl.const('transformed').assign(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dsl(inputTransformerSymbol as any)
          .call(
            optionsRequired
              ? 'options'
              : // `options ?? {}` when the parameter is optional — guards
                // the transformer (which extracts `input.<slot>`) against
                // undefined. Spread of undefined elsewhere is a no-op so
                // `{ ...options, ...transformed }` is fine without the
                // coalesce.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (dsl('options').coalesce(dsl.object()) as any)
          )
          .await()
      )
    );
  }

  if (errorTransformerSymbol) {
    // Steps 2 + 3 — error decoding via try/catch + result.error in-place
    // decode. Using a typed-then-throw pattern with an explicit `let`
    // because hand-rolling `try { throw await … } catch (typed) { … }`
    // catches its own throw and gets messy. The outer try captures
    // network errors that aren't HTTP error bodies — those re-throw raw.
    //
    // `result` is declared with `let` outside the try so the body that
    // follows the catch can read it (block-scoped `const result` inside
    // the try would be unreachable). The inner `try` assigns it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bodyStatements.push((dsl as any).let('result'));
    bodyStatements.push(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dsl as any)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .try((dsl('result') as any).assign(sdkCallExpr))
        .catchArg('err')
        .catch(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (dsl as any).let('typedErr'),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (dsl as any)
            .try(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (dsl('typedErr') as any).assign(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                dsl(errorTransformerSymbol as any)
                  .call('err')
                  .await()
              )
            )
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .catch((dsl as any).throw('err', false)),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (dsl as any).throw('typedErr', false)
        )
    );

    // throwOnError: false path — `result` is set, decode error in place.
    // The SDK function's static return type is a union of
    // `{ data, request, response }` (throwOnError: true) and
    // `{ data, error, … }` (throwOnError: false). TS doesn't know that
    // the throwOnError: true variant can't reach this code (it would
    // have thrown above), and the union doesn't have `error` on every
    // member, so direct access fails the structural check. Cast through
    // a narrow `{ error?: unknown }` view to do the in-place mutation —
    // the cast is sound because at runtime the throwOnError: true
    // variant simply doesn't have an `error` field, so the access is
    // a no-op (undefined). Caller's view of `result` (the wrapper's
    // return value) keeps the SDK's discriminated-union typing
    // unchanged.
    bodyStatements.push(
      dsl.const('errorBearing').assign(
        dsl.as(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          dsl('result') as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (dsl.type.object() as any).prop(
            'error',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (p: any) => p.optional().type(dsl.type('unknown'))
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ) as any
        )
      )
    );
    bodyStatements.push(
      dsl.if(dsl('errorBearing').attr('error').neq(dsl.id('undefined'))).do(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (dsl as any)
          .try(
            dsl('errorBearing')
              .attr('error')
              .assign(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                dsl(errorTransformerSymbol as any)
                  .call(dsl('errorBearing').attr('error'))
                  .await()
              )
          )
          // Empty catch — leave wire shape on parse failure. See the
          // function-level comment for why we don't propagate the
          // ZodError on the throwOnError: false path.
          .catch()
      )
    );

    bodyStatements.push(dsl.return('result'));
  } else {
    // No error transformer — return the SDK call directly.
    bodyStatements.push(sdkCallExpr.return());
  }

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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .do(...(bodyStatements as any[]))
      )
  );
}

// ── TanStack Query factory codegen ────────────────────────────────────────────

/**
 * Symbols stashed when the tanstack scaffolding emits, then reused by every
 * per-operation factory so each emit doesn't repeat the lookup.
 *
 * A single object so the scaffold-on-first-use closure can populate it in
 * place — the alternative is threading three references through the operation
 * forEach.
 */
interface TanstackScaffoldState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryOptionsSymbol?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultErrorSymbol?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createQueryKeySymbol?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryKeyTypeSymbol?: any;
}

/**
 * Emit the file-level scaffolding the per-op factories share:
 * `queryOptions` (value) and `DefaultError` (type) imports from
 * `@tanstack/react-query`, the `QueryKey<TOptions>` type alias, and the
 * `createQueryKey` utility.
 *
 * Mirrors what the upstream `@tanstack/react-query` plugin emits — same
 * runtime shape, same field names, so the queryKey identity stays stable for
 * consumers migrating from the upstream factories. The only deliberate
 * deviation: we drop the `_infinite` and `tags` fields because we don't
 * implement infinite queries here (yet — see "what's not covered" in the
 * README) and slimmer keys are easier to reason about.
 */
function scaffoldTanstack({
  dsl,
  plugin,
  state
}: {
  dsl: Dsl;
  plugin: PluginLike;
  state: TanstackScaffoldState;
}): void {
  // queryOptions value — runtime import for the factory body.
  // Registration shape MUST match the upstream `@tanstack/react-query`
  // plugin's: same `name`, same `external`, no extra `meta`. Without
  // this, hey-api treats the two as distinct symbols, sees a name
  // collision across files, and emits a broken import like
  // `import { queryOptions2 } from '@tanstack/react-query'` (no `as`
  // alias — upstream codegen bug). Matching exactly lets hey-api
  // deduplicate to a single shared symbol per file.
  const queryOptionsSymbol = plugin.symbol('queryOptions', {
    external: '@tanstack/react-query'
  });
  state.queryOptionsSymbol = queryOptionsSymbol;

  // DefaultError type — used for ops without an Errors bucket. Same
  // shape rule as queryOptions above.
  const defaultErrorSymbol = plugin.symbol('DefaultError', {
    external: '@tanstack/react-query',
    kind: 'type'
  });
  state.defaultErrorSymbol = defaultErrorSymbol;

  // The Options type lives in sdk.gen.ts. Reference rather than declare —
  // the SDK plugin emits it.
  const referenceSymbol = plugin.referenceSymbol;
  if (!referenceSymbol) {
    throw new Error(
      `[zod-to-openapi-heyapi] plugin.referenceSymbol is not available. ` +
        `Cannot scaffold TanStack Query factories. This likely means the hey-api ` +
        `version is incompatible — check the @hey-api/openapi-ts peer-dep range.`
    );
  }
  const optionsSymbol = referenceSymbol.call(plugin, {
    category: 'type',
    resource: 'client-options',
    tool: 'sdk'
  });

  // The client value lives in client.gen.ts. The fetch-client plugin
  // registers it with `category: 'client'` — reference, don't redeclare.
  const clientSymbol = referenceSymbol.call(plugin, { category: 'client' });

  // ── QueryKey<TOptions> type alias ───────────────────────────────────────
  // export type QueryKey<TOptions extends Options> = [
  //   Pick<TOptions, 'baseUrl' | 'body' | 'headers' | 'path' | 'query'> & {
  //     _id: string;
  //   }
  // ];
  const queryKeyTypeSymbol = plugin.symbol('QueryKey', {
    meta: { category: 'type', tool: 'tanstack', name: 'QueryKey' }
  });
  state.queryKeyTypeSymbol = queryKeyTypeSymbol;
  const queryKeyEntryType = dsl.type.and(
    dsl.type(
      // The Pick keys are emitted as a literal-union type via a string —
      // simpler than building five `dsl.type.literal(...)` calls when the
      // value is purely textual and won't change.
      `Pick<TOptions, 'baseUrl' | 'body' | 'headers' | 'path' | 'query'>`
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dsl.type.object() as any).prop('_id', (p: any) => p.type('string'))
  );
  plugin.node(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dsl.type.alias(queryKeyTypeSymbol as any) as any)
      .export()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .generic('TOptions', (g: any) => g.extends(optionsSymbol))
      .type(dsl.type.tuple(queryKeyEntryType))
  );

  // ── createQueryKey utility ──────────────────────────────────────────────
  // Identical shape to the upstream tanstack plugin's emission, minus the
  // _infinite / tags fields we don't use. The slot copy chain (body /
  // headers / path / query) preserves whichever slots the caller supplied
  // and drops the rest — the queryKey shouldn't carry undefined slots since
  // tanstack hashes keys with JSON.stringify and undefined values stringify
  // away unevenly.
  const createQueryKeySymbol = plugin.symbol('createQueryKey', {
    meta: { category: 'utility', tool: 'tanstack', name: 'createQueryKey' }
  });
  state.createQueryKeySymbol = createQueryKeySymbol;
  // The returned tuple's element type — `QueryKey<TOptions>[0]`. Used both
  // as the `params` declaration's type and the return type. Re-built per use
  // because some DSL nodes can't be re-rendered.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entryType = (): any =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dsl.type(queryKeyTypeSymbol as any).generic('TOptions') as any).idx(0);

  const slotCopies: ReadonlyArray<readonly ['body' | 'headers' | 'path' | 'query']> = [
    ['body'],
    ['headers'],
    ['path'],
    ['query']
  ];
  plugin.node(
    dsl
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .const(createQueryKeySymbol as any)
      .assign(
        dsl
          .func()
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .generic('TOptions', (g: any) => g.extends(optionsSymbol))
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .param('id', (p: any) => p.type('string'))
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .param('options', (p: any) => p.optional().type('TOptions'))
          .returns(dsl.type.tuple(entryType()))
          .do(
            dsl
              .const('params')
              .type(entryType())
              .assign(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (dsl.object() as any as any)
                  .prop('_id', dsl.id('id'))
                  .prop(
                    'baseUrl',
                    // options?.baseUrl || (options?.client ?? client).getConfig().baseUrl
                    dsl('options')
                      .attr('baseUrl')
                      .optional()

                      .or(
                        dsl('options')
                          .attr('client')
                          .optional()
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          .coalesce(dsl(clientSymbol as any))
                          .attr('getConfig')
                          .call()
                          .attr('baseUrl')
                      )
                  )
                  .as(entryType())
              ),
            ...slotCopies.map(([slot]) =>
              dsl
                .if(dsl('options').attr(slot).optional())
                .do(dsl('params').attr(slot).assign(dsl('options').attr(slot)))
            ),
            dsl.return(dsl.array(dsl('params')))
          )
      )
  );
}

interface EmitTanstackQueryFactoryArgs {
  dsl: Dsl;
  plugin: PluginLike;
  operation: IR.OperationObject;
  opId: string;
  hasErrorBucket: boolean;
  /** Always defined — caller (the operation forEach) gates emission on the
   *  presence of registered input schemas. */
  inputSlots: OpInputSlots;
  scaffold: TanstackScaffoldState;
}

/**
 * Emit `${opId}QueryKey` and `${opId}Options` for one codec-bearing
 * operation. Non-codec ops are emitted by the upstream
 * `@tanstack/react-query` plugin — see the gating in the operation
 * `forEach` for why.
 *
 * The factories type their `options` parameter against `${Op}Input` so the
 * caller passes runtime shapes (`bigint`, `Date`, etc.). Codec slots are
 * pre-encoded into the queryKey via sync `z.encode(Schema, options.<slot>)`,
 * so the queryKey carries wire-shape values — keeping the default
 * `JSON.stringify` queryKey hash function happy when the runtime shape is
 * `bigint` or other non-JSON type.
 *
 * The queryFn calls the raw SDK function (`${opId}2`, the auto-aliased
 * import from `sdk.gen.ts`), not our SDK wrapper — the wrapper would
 * re-encode the already-wire-shaped slots in `queryKey[0]`. The
 * merged-options cast to `Options<${Op}Data>` papers over the structural
 * overlap between the codec input and the wire shape (TypeScript sees the
 * union of both spreads, not the runtime override).
 */
function emitTanstackQueryFactory({
  dsl,
  plugin,
  operation,
  opId,
  hasErrorBucket,
  inputSlots,
  scaffold
}: EmitTanstackQueryFactoryArgs): void {
  const referenceSymbol = plugin.referenceSymbol;
  if (!referenceSymbol) {
    throw new Error(
      `[zod-to-openapi-heyapi] plugin.referenceSymbol is not available. ` +
        `Cannot emit TanStack Query factory for '${opId}'. This likely means ` +
        `the hey-api version is incompatible — check the @hey-api/openapi-ts ` +
        `peer-dep range.`
    );
  }
  if (
    !scaffold.queryOptionsSymbol ||
    !scaffold.defaultErrorSymbol ||
    !scaffold.createQueryKeySymbol ||
    !scaffold.queryKeyTypeSymbol
  ) {
    // The scaffold should have populated all four symbols — if any is
    // missing, `scaffoldTanstack` returned without registering them and
    // we'd silently emit a factory that references undeclared symbols.
    // Throw to surface the bug at codegen time instead.
    throw new Error(
      `[zod-to-openapi-heyapi] tanstack scaffolding incomplete for '${opId}'. ` +
        `Missing symbols: ${[
          !scaffold.queryOptionsSymbol && 'queryOptionsSymbol',
          !scaffold.defaultErrorSymbol && 'defaultErrorSymbol',
          !scaffold.createQueryKeySymbol && 'createQueryKeySymbol',
          !scaffold.queryKeyTypeSymbol && 'queryKeyTypeSymbol'
        ]
          .filter(Boolean)
          .join(', ')}. This is a plugin bug — please report.`
    );
  }

  // Cross-file references — sdk.gen.ts owns the raw SDK function and the
  // Options/Data type; types.gen.ts owns ${Op}Data; we own ${Op}Input and the
  // ${Op}Response/${Op}Error type aliases (already emitted earlier in this
  // forEach pass).
  const sdkSymbol = referenceSymbol.call(plugin, {
    category: 'sdk',
    resource: 'operation',
    resourceId: opId,
    tool: 'sdk'
  });
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

  const responseSymbol = plugin.querySymbol({
    category: 'type',
    resource: 'operation',
    resourceId: opId,
    role: 'response'
  });
  if (!responseSymbol) return;

  const errorSymbol = hasErrorBucket
    ? plugin.querySymbol({
        category: 'type',
        resource: 'operation',
        resourceId: opId,
        role: 'error'
      })
    : undefined;

  // Always defined: emission is gated on `inputSlots` being present, so
  // the SDK wrapper has already emitted `${Op}Input`.
  const inputSymbol = plugin.querySymbol({
    category: 'type',
    resource: 'operation',
    resourceId: opId,
    role: 'input'
  });
  if (!inputSymbol) return;

  const optionsRequired =
    isSlotRequiredInOpData(operation, 'path') ||
    isSlotRequiredInOpData(operation, 'query') ||
    isSlotRequiredInOpData(operation, 'body') ||
    isSlotRequiredInOpData(operation, 'headers');

  // Options<${Op}Input> as a type expression — re-built per use because
  // some DSL nodes can't be re-rendered safely.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const optionsTypeExpr = (): any =>
    dsl
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .type(optionsSymbol as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .generic(dsl.type(inputSymbol as any));

  // ── ${opId}QueryKey ─────────────────────────────────────────────────────
  // createQueryKey(opId, { ...options, ...encodedSlots } as
  // Options<${Op}Data>) — the cast lets us hand a value typed against the
  // codec input to a function expecting the wire shape, after we've spread
  // the encoded slots over it.
  const queryKeySymbol = plugin.symbol(`${opId}QueryKey`, {
    meta: {
      category: 'hook',
      resource: 'operation',
      resourceId: opId,
      role: 'queryKey',
      tool: 'tanstack'
    }
  });

  const buildEncodedOptions = (): unknown => {
    const obj = dsl.object();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (obj as any).spread('options');
    type SlotKey = 'path' | 'query' | 'body' | 'headers';
    const slotEntries: ReadonlyArray<readonly [SlotKey, string]> = (
      [
        ['path', inputSlots.params],
        ['query', inputSlots.query],
        ['body', inputSlots.body],
        ['headers', inputSlots.headers]
      ] as const
    ).filter((entry): entry is readonly [SlotKey, string] => entry[1] !== undefined);
    const zSymbol = plugin.querySymbol({ category: 'utility', tool: 'zod', name: 'z' });
    if (!zSymbol) return dsl.id('options');
    for (const [slot, schemaName] of slotEntries) {
      const schemaSym = plugin.querySymbol({
        category: 'schema',
        tool: 'zod',
        resource: 'registry',
        name: schemaName
      });
      if (!schemaSym) continue;
      // ...(options?.<slot> !== undefined
      //       ? { <slot>: z.encode(Schema, options.<slot>) }
      //       : {})
      //
      // Optional-chain on the conditional handles the optional-options
      // case (route with all-optional input slots → factory's `options`
      // is `?:`). Inside the truthy branch, the narrowing guarantees
      // both `options` and `options.<slot>` are defined, so the
      // straight `options.<slot>` access in the encoded payload is
      // sound. z.encode is synchronous — returning the encoded value
      // directly so the queryKey factory can stay sync (tanstack's
      // queryKey getter can't be a Promise).
      // Always use the `options?.<slot>` access — `optional()` after `attr`
      // emits `?.` between `options` and the slot (`options?.path`), which
      // is safe whether `options` is the required or `?:` variant. Pinning
      // the chain on `options` directly would force a type-narrowing branch
      // for the optional case; this keeps the emit uniform.
      const slotAccess = dsl('options').attr(slot).optional();
      const encodedSlotObject = dsl.object();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (encodedSlotObject as any).prop(
        slot,
        dsl(zSymbol)
          .attr('encode')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .call(dsl(schemaSym as any), dsl('options').attr(slot).optional())
      );
      const guard = slotAccess.neq(dsl.id('undefined'));
      const conditional = dsl
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .ternary(guard as any)
        .do(encodedSlotObject)
        .otherwise(dsl.object());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (obj as any).spread(conditional);
    }
    return dsl.as(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      obj as any,
      dsl
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .type(optionsSymbol as any)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .generic(dsl.type(opDataSymbol as any)) as any
    );
  };

  plugin.node(
    dsl
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .const(queryKeySymbol as any)
      .export()
      .assign(
        dsl
          .func()
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .param('options', (p: any) => p.required(optionsRequired).type(optionsTypeExpr()))
          .do(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            dsl(scaffold.createQueryKeySymbol as any)
              .call(
                dsl.literal(opId),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                buildEncodedOptions() as any
              )
              .return()
          )
      )
  );

  // ── ${opId}Options ──────────────────────────────────────────────────────
  // queryOptions<Response, Error|DefaultError, Response, ReturnType<typeof QueryKey>>({
  //   queryFn: async ({ queryKey, signal }) => {
  //     const { data } = await rawSdk({ ...options, ...queryKey[0], signal, throwOnError: true } as Options<Data>);
  //     return data;
  //   },
  //   queryKey: ${opId}QueryKey(options)
  // })
  const optionsFnSymbol = plugin.symbol(`${opId}Options`, {
    meta: {
      category: 'hook',
      resource: 'operation',
      resourceId: opId,
      role: 'queryOptions',
      tool: 'tanstack'
    }
  });

  // Generic args for queryOptions: <Response, Error, Response, QueryKeyReturn>.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const responseTypeExpr = (): any => dsl.type(responseSymbol as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const errorTypeExpr = (): any =>
    errorSymbol
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dsl.type(errorSymbol as any)
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dsl.type(scaffold.defaultErrorSymbol as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const queryKeyReturnExpr = (): any =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dsl.type('ReturnType') as any).generic(dsl.type.query(dsl(queryKeySymbol as any)));

  const fetchObjectLiteral = dsl.object();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fetchObjectLiteral as any).spread('options');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fetchObjectLiteral as any).spread(dsl('queryKey').attr(0));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fetchObjectLiteral as any).prop('signal', dsl.id('signal'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fetchObjectLiteral as any).prop('throwOnError', dsl.literal(true));

  // The cast bridges `Options<${Op}Input>` (path: bigint) and
  // `Options<${Op}Data>` (path: string) — TypeScript can't see that the
  // second spread (queryKey[0]) overrides the first (options), so the
  // merged object literal's structural type would error otherwise. Pinning
  // `ThrowOnError = true` is critical: without it, `Options<TData>`
  // defaults ThrowOnError to `boolean`, the SDK function picks the "may
  // return error" overload, `data` becomes `T | undefined`, and `return
  // data` fails the queryFn's `Promise<T>` contract.
  const fetchArg = dsl.as(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchObjectLiteral as any,
    dsl
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .type(optionsSymbol as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .generic(dsl.type(opDataSymbol as any))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .generic(dsl.type.literal(true)) as any
  );

  const queryFnBody = dsl
    .const()
    .object('data')
    .assign(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dsl(sdkSymbol as any).call(fetchArg as any) as any).await()
    );

  const queryOptionsObject = dsl.object();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (queryOptionsObject as any).prop(
    'queryFn',
    dsl
      .func()
      .async()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .param((p: any) => p.object('queryKey', 'signal'))
      .do(queryFnBody, dsl.return(dsl.id('data')))
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (queryOptionsObject as any).prop(
    'queryKey',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dsl(queryKeySymbol as any).call('options')
  );

  plugin.node(
    dsl
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .const(optionsFnSymbol as any)
      .export()
      .assign(
        dsl
          .func()
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .param('options', (p: any) => p.required(optionsRequired).type(optionsTypeExpr()))
          .do(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            dsl(scaffold.queryOptionsSymbol as any)
              .call(queryOptionsObject)
              .generics(
                responseTypeExpr(),
                errorTypeExpr(),
                responseTypeExpr(),
                queryKeyReturnExpr()
              )
              .return()
          )
      )
  );
}
