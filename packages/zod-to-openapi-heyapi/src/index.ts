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
import type { CallExpression, Expression } from 'typescript';

import { getRefId } from '@asteasolutions/zod-to-openapi';
// Used to hand-construct a TypePredicateNode for the wrapper-emitted
// `isTransportError` / `isResponseValidationError` type guards (and the
// computed-key element-access assignment in their classes) — the
// openapi-ts DSL doesn't expose type predicates or computed property
// access as first-class nodes, so we drop down to the raw TS factory.
import { factory as tsFactory, SyntaxKind } from 'typescript';

import { containsCodec } from './contains-codec.ts';

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
   * a package specifier (`@org/pkg`, `@org/pkg/zod`) or a `file://` URL. The
   * plugin dynamic-imports this specifier at codegen time to run the audit,
   * so a relative path like `'../schemas'` won't work — its meaning depends
   * on who's importing it, and the plugin's perspective differs from the
   * generated client's. A package.json `imports` alias (`'#schemas'`) does
   * NOT work either: Node resolves `#` aliases against the package containing
   * the importing module, and the plugin imports from its own install
   * location, where the consumer's alias doesn't exist. When schemas live in
   * the same package as the codegen, give the package a `name` + `exports`
   * entry, self-link it (`"<name>": "link:."` in devDependencies), and pass
   * the package's own name — see the README's resolution table.
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

  // Input slots resolve to importable names via registration metadata —
  // the refId that `.openapi('Name')` / `register('Name', schema)` attached
  // to the exact schema instances the registry holds. No second evaluation
  // of the schemas module is ever consulted for resolution, so it is
  // immune to the c12/jiti vs native-loader module split a custom export
  // condition produces. Throws for unregistered codec-bearing slots.
  const inputsByOpId = collectInputSchemasFromRegistry({ registry, schemasFrom });

  // Codegen-time audit. `schemasFrom` is the module the generated client
  // imports schemas from at runtime; dynamic-import it here to verify that
  // every name the plugin will emit `import { Name } from '<schemasFrom>'`
  // for — response `$ref` targets and registered input-slot schemas alike —
  // exists as a Zod-shaped named export. This is a pure string-membership
  // check: no instance identity is compared anywhere, so a second module
  // evaluation (different instances, identical export names) passes it
  // just the same.
  let schemasModule: Record<string, unknown>;
  try {
    schemasModule = (await import(schemasFrom)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(buildSchemasFromImportError(schemasFrom, err));
  }

  const responseRefNames = new Set<string>();
  for (const name of collectResponseRefSchemaNames(doc)) {
    if (registrySchemaNames.has(name)) responseRefNames.add(name);
  }

  const inputSchemaNames = new Set<string>();
  for (const slots of inputsByOpId.values()) {
    for (const name of slotSchemaNames(slots)) inputSchemaNames.add(name);
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
  for (const name of inputSchemaNames) {
    if (responseRefNames.has(name)) continue; // already audited above
    if (!(name in schemasModule)) {
      errors.push(
        `'${name}' is registered on a request slot but is not a named export of '${schemasFrom}'. ` +
          `The plugin emits \`import { ${name} } from '${schemasFrom}'\` to encode that slot's values ` +
          `(z.encode) before serialisation, which will fail at consumer build time. ` +
          `Export the registered schema from that module under that exact name.`
      );
      continue;
    }
    const value = schemasModule[name];
    if (!isLikelyZodType(value)) {
      errors.push(
        `'${name}' is exported from '${schemasFrom}' but does not appear to be a Zod schema (got ${describeType(value)}). ` +
          `The plugin emits \`z.encode(${name}, value)\`, which will fail at consumer runtime.`
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

      // ZodError type import + the wrapper-emitted error classes
      // (TransportError, ResponseValidationError) are scaffolded lazily on first use
      // by an SDK wrapper that needs them — any op with a declared
      // error schema. The classes give consumers a tag-based discriminator
      // so they don't have to `instanceof` at narrow sites:
      //
      //   if (error?._tag === '__zod_to_openapi_transport_error__') {
      //     // request never completed — error.cause is the native fetch error
      //     // (TypeError / AbortError / Node SystemError carrying ECONNRESET, etc.)
      //   } else if (error?._tag === '__zod_to_openapi_unknown_error__') {
      //     // got an HTTP response, didn't match our schema — error.cause
      //     // is the ZodError; error.cause.cause is the original wire body
      //   } else if (error) {
      //     // typed `${Op}Error`
      //   }
      //
      // Two distinct classes, not one with a discriminator field, because
      // "request never reached the API" (transport) and "API responded
      // but we couldn't decode" (unknown) are categorically different
      // failure modes — the consumer's handling, retry logic, alerting
      // surfaces are typically different. Pretending they're the same
      // class with sub-types would invite mis-handling.
      let wrapperErrorClassesEmitted = false;
      const ensureWrapperErrorClasses = (): void => {
        if (wrapperErrorClassesEmitted) return;
        wrapperErrorClassesEmitted = true;
        emitWrapperErrorClasses({ dsl, plugin });
      };

      // Pass-through ops have no error transformer, so the gate above
      // never fires for them. They still need a return-type alias that
      // threads `TResponseStyle` through hey-api's 'fields' / 'data'
      // conditional — emit `WrapPassThrough` separately the first time
      // a pass-through wrapper needs it.
      let wrapPassThroughEmitted = false;
      const ensureWrapPassThrough = (): void => {
        if (wrapPassThroughEmitted) return;
        wrapPassThroughEmitted = true;
        emitWrapPassThroughAlias({ dsl, plugin });
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
        const distinctErrorSchemas = uniqueSchemaNames(buckets.error);

        // Wrapper error classes (TransportError, ResponseValidationError)
        // are needed by any op that emits a transformer of either role:
        // the response transformer throws ResponseValidationError itself
        // when a 2xx body fails `parseAsync` (so the failure doesn't get
        // misclassified as a TransportError by the wrapper's generic
        // `instanceof Error` catch), and the error transformer's failures
        // are wrapped by the SDK wrapper. Emit the classes BEFORE the
        // transformers so `emitParseTransformer` can resolve the class
        // symbol. Ops with no schemas at all skip the scaffolding.
        if (distinctSuccessSchemas.length > 0 || distinctErrorSchemas.length > 0) {
          ensureWrapperErrorClasses();
        }

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
        if (!errorTransformerSymbol && !hasInputSlots) {
          // Pass-through op (no error decoding, no input encoding).
          // It still needs `WrapPassThrough` for its return-type
          // annotation; emit the alias lazily on first pass-through.
          ensureWrapPassThrough();
        }

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
 *   - `@hey-api/client-fetch` with `includeInEntry: true` so the
 *     singleton `client` reaches the auto-barrel.
 *   - `@hey-api/sdk` with `transformer: true` and `includeInEntry: false`
 *     — both required for the codec round-trip to fire and for the
 *     entry barrel to expose only this plugin's wrappers.
 *
 * The auto-generated `index.ts` is the canonical consumer surface: it
 * re-exports the singleton `client`, every SDK wrapper, both wrapper-
 * error classes plus their `is*Error` guards, and (when enabled) every
 * TanStack Query factory regardless of codec status. Consumers — and the
 * consumer package's own hand-written barrel — should import only from
 * this entry; they should never reach into `*.gen.ts` paths directly.
 *
 * When `tanstackReactQuery: true`, it additionally:
 *
 *   - Adds `'@tanstack/react-query'` to the plugin list with
 *     `includeInEntry: true`, so non-codec ops' `${Op}Options` /
 *     `${Op}QueryKey` factories reach the auto-barrel.
 *   - Installs a `parser.hooks.operations.isQuery` hook that returns
 *     `false` for every operation id with a registered input schema, so
 *     the upstream tanstack plugin skips those — this plugin emits them
 *     instead with codec-aware typing. Both factory files contribute to
 *     the entry under one canonical name per op id, no collisions.
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
    // `@hey-api/typescript` emits wire-shape types into `types.gen.ts`
    // (e.g. `${Op}Response` typed as the unparsed JSON shape, with
    // `string` for codec slots). Our plugin emits codec-aware aliases
    // with the same names in `registry-validator.gen.ts` (e.g. the
    // bigint runtime version). With both plugins exporting through
    // the auto-barrel, hey-api collision-renames the typescript
    // plugin's exports to `${Name}2` — `CreateOrderError2`,
    // `CreateOrderResponse2`, etc. — and re-exports both. Consumers
    // who reach for `CreateOrderError2` thinking it's a v2 / alternate
    // form get the wire shape (string instead of bigint, ISO string
    // instead of Date) and the codec round-trip silently breaks.
    //
    // Setting `includeInEntry: false` here keeps the wire-shape types
    // out of the public barrel. They still exist in `types.gen.ts` for
    // advanced power users importing the deep path, but the canonical
    // public surface is the codec-aware ones from our plugin.
    { name: '@hey-api/typescript', includeInEntry: false },
    // `@hey-api/client-fetch` defaults to `includeInEntry: false`, which
    // would leave the singleton `client` out of the auto-barrel and force
    // consumers (or the consumer package's own hand-written barrel) to
    // reach into `./client.gen.js` directly. Flipping it on routes the
    // singleton through the canonical entry — `client.gen.ts` exports
    // only `client` and the `CreateClientConfig` type, neither of which
    // collide with anything else this plugin emits.
    { name: '@hey-api/client-fetch', includeInEntry: true },
    { name: '@hey-api/sdk', transformer: true, includeInEntry: false },
    // Same reasoning for the upstream `@tanstack/react-query` plugin:
    // it emits non-codec ops' `${Op}Options` / `${Op}QueryKey` factories
    // (and `${Op}Mutation` for codec ops, which our `isQuery: false`
    // hook routes to the upstream's mutation path) into
    // `@tanstack/react-query.gen.ts`, and the default `includeInEntry`
    // would keep those out of the auto-barrel.
    //
    // The predicate filters out `QueryKey` because this plugin emits its
    // own canonical `QueryKey<TOptions>` alias (scaffolded by
    // {@link scaffoldTanstack}) — letting both contribute would collide
    // in the auto-generated `index.ts` and TypeScript fails the
    // duplicate-export. Our `QueryKey` is the public-surface alias the
    // consumer reaches for; the upstream's is an internal-shape alias
    // that nothing useful imports.
    ...(tanstack
      ? ([
          {
            name: '@tanstack/react-query',
            includeInEntry: (sym: { name: string }): boolean => sym.name !== 'QueryKey'
          }
        ] as const)
      : [])
  ];

  // Build the parser hook only when tanstack is wired. Skipped otherwise
  // so non-tanstack consumers' `isQuery` resolution stays default.
  let parser: UserConfig['parser'] = opts.parser;
  if (tanstack) {
    const codecOpIds = collectCodecOpIds({
      registry: opts.registry,
      schemasFrom: opts.schemasFrom
    });
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
function collectCodecOpIds({
  registry,
  schemasFrom
}: {
  registry: RegistryLike;
  schemasFrom: string;
}): ReadonlySet<string> {
  return new Set(collectInputSchemasFromRegistry({ registry, schemasFrom }).keys());
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
    `a package specifier (\`@org/pkg\`, \`@org/pkg/zod\`) or a \`file://\` URL. ` +
    `Relative paths like \`'../schemas'\` don't work because they mean different things to the plugin ` +
    `and the generated client. package.json \`imports\` aliases (\`#schemas\`) don't work either — ` +
    `they resolve against the package containing the importing module, and the plugin imports from ` +
    `its own install location. For schemas living inside the codegen package itself, self-link the ` +
    `package (\`"<name>": "link:."\`) and pass its own name.`;

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

  // Note: `responseStyle` doesn't need a pre-flight check. The
  // emitted `WrapErrors<TData, TError, ThrowOnError, TResponseStyle>`
  // type takes a 4th `TResponseStyle` generic that conditionally
  // produces hey-api's 'fields' or 'data' return shape, and every
  // wrapper signature carries the same 4th generic. Static and
  // runtime stay in step in both modes — see `emitWrapErrorsAlias`.

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
 * Walk `registry.definitions` and, for each route, resolve every input
 * ZodType reference (held inside `request.{params, query, body, headers}`)
 * to its registration name — the refId that `.openapi('Name')` /
 * `register('Name', schema)` attached to the instance the route holds.
 *
 * The refId is read from the exact instances the registry hands us, so
 * resolution never consults a second evaluation of the schemas module and
 * is immune to the c12/jiti vs native-loader module split a custom export
 * condition (e.g. `@polygonlabs/source` build-free codegen) produces —
 * the failure mode that silently dropped every codec input transformer
 * when this lookup was identity-based. The resolved name follows the same
 * audited contract as response schemas: {@link registryPlugin} verifies it
 * is a Zod-shaped named export of `schemasFrom` before emitting anything,
 * so `import { Name } from '<schemasFrom>'` + `z.encode(Name, value)` is
 * guaranteed to resolve at consumer build time. The natural pattern:
 *
 *     // schemas.ts
 *     export const BlockNumberPathParams = z
 *       .object({ blockNumber: Int64Codec })
 *       .openapi('BlockNumberPathParams');
 *
 *     // routes/blocks.ts
 *     registry.registerPath({
 *       request: { params: BlockNumberPathParams },  // ← the registered export
 *       ...
 *     });
 *
 * Unregistered slots (no refId) split on codec content:
 *   - Codec-free — anonymous inline schema (`params: z.object({ id:
 *     z.uuid() })` written directly in the route). Intentional, common,
 *     silently skipped.
 *   - Codec-bearing — fails the codegen loudly (see the guard below).
 *     Skipping it would emit a client that types the slot wire-shaped and
 *     never runs `z.encode`, sending wire-invalid values (a `Date`
 *     serialised as a locale string instead of ISO-8601) while compiling
 *     clean.
 */
function collectInputSchemasFromRegistry({
  registry,
  schemasFrom
}: {
  registry: RegistryLike;
  schemasFrom: string;
}): Map<string, OpInputSlots> {
  const out = new Map<string, OpInputSlots>();
  const unregisteredCodecSlots: string[] = [];

  const lookupSlot = (
    schema: unknown,
    opId: string,
    slotKind: 'path' | 'query' | 'body' | 'headers'
  ): string | undefined => {
    if (!schema || typeof schema !== 'object') return undefined;
    if (!isLikelyZodType(schema)) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const refId = getRefId(schema as any);
    if (refId) return refId;

    // Unregistered. A codec-bearing slot must not be skipped silently:
    // the emitted client would type the slot wire-shaped and never run
    // `z.encode`, sending wire-invalid values (e.g. a Date serialising as
    // a locale string instead of ISO-8601). Collect and hard-fail below.
    // Detection is structural (`containsCodec` walks the def tree), so it
    // needs neither registration metadata nor module identity.
    if (containsCodec(schema)) {
      unregisteredCodecSlots.push(`operation '${opId}' request.${slotKind}`);
      return undefined;
    }

    // Codec-free and unregistered — the anonymous-inline-schema case.
    // Intentional, common, silent.
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

  // Loud-failure guard: never emit a silently-degraded client. Each slot
  // listed here contains a codec but carries no registration name — input
  // encoding would be skipped and the generated client would send
  // wire-invalid values for those fields while compiling clean.
  if (unregisteredCodecSlots.length > 0) {
    throw new Error(
      `[zod-to-openapi-heyapi] ${unregisteredCodecSlots.length} request slot(s) contain Zod codecs ` +
        `but are not registered schemas:\n` +
        unregisteredCodecSlots.map((s) => `  - ${s}`).join('\n') +
        `\n\nCodec-bearing input schemas must be registered and exported so the generated client ` +
        `can import them and encode requests (z.encode) before serialisation. Skipping them ` +
        `silently would emit a client that sends wire-invalid values for codec fields (e.g. a ` +
        `Date serialised as a locale string instead of ISO-8601), so codegen refuses instead.\n\n` +
        `Fix: register each listed slot's schema and export it from '${schemasFrom}' under the ` +
        `registered name —\n\n` +
        `  export const MySlotSchema = z.object({ ... }).openapi('MySlotSchema');\n\n` +
        `— then use that exported value in the route's \`request\` block. The route must hold ` +
        `the registered instance (the value returned by .openapi(...) / register(...)), since ` +
        `registration metadata travels with the instance.`
    );
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

  // Body statement(s), by role:
  //
  //   - 'error': bare `return await Schema.parseAsync(data)`. The SDK
  //     wrapper invokes this transformer itself inside a try/catch and
  //     wraps a rejection as `ResponseValidationError(zodError, body)` —
  //     the wire body is in the wrapper's scope there.
  //   - 'response': hey-api's fetch client invokes this transformer
  //     internally on every 2xx body, so a bare `parseAsync` rejection
  //     surfaces to the wrapper as a generic thrown `Error` — which the
  //     wrapper's transport branch used to misclassify as a
  //     TransportError (a schema-violating SUCCESS body is the single
  //     most important thing this client detects, and it was reported
  //     as a network failure). This is also the only scope where the
  //     parsed 2xx body is still reachable, so the transformer wraps
  //     its own rejection: `throw new ResponseValidationError(err, data)`.
  //     The `as ZodError` cast mirrors the wrapper's error-transformer
  //     catch — `parseAsync` rejects with ZodError by contract.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let transformerStatements: any;
  const parseCallExpr = transformerBody.attr('parseAsync').call('data').await();
  if (role === 'response') {
    const responseValidationSymbol = plugin.querySymbol({
      category: 'class',
      resource: 'wrapper-error',
      name: 'ResponseValidationError'
    });
    const zodErrorTypeSymbol = plugin.querySymbol({
      category: 'type',
      tool: 'zod',
      name: 'ZodError'
    });
    if (!responseValidationSymbol || !zodErrorTypeSymbol) {
      throw new Error(
        `[zod-to-openapi-heyapi] wrapper-error classes missing while emitting ` +
          `'${transformerName}' — ensureWrapperErrorClasses() should have run ` +
          `before emitParseTransformer for role 'response'. Plugin bug.`
      );
    }
    transformerStatements =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dsl as any)
        .try(parseCallExpr.return())
        .catchArg('err')
        .catch(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (dsl as any).throw(
            dsl
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .new(responseValidationSymbol as any)
              .args(
                dsl.as(
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  dsl('err') as any,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  dsl.type(zodErrorTypeSymbol as any)
                ),
                dsl.id('data')
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ) as any,
            false
          )
        );
  } else {
    transformerStatements = parseCallExpr.return();
  }

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
          .do(transformerStatements)
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
 *     decodes it, and re-throws the typed result. If `parseAsync`
 *     fails (response doesn't match any registered error schema —
 *     server bug, stale schema, or network-level error surfaced
 *     through the catch), the validation error throws on **both** paths,
 *     regardless of the `throwOnError` flag. This is the same
 *     contract the input transformer has always had: `z.encode`
 *     failures throw out of the wrapper because the type system
 *     promised the codec runtime shapes and a wire-shape leak in
 *     `result.error` would re-open the exact type/runtime gap this
 *     work was added to close. `${Op}Error` stays narrow
 *     (`z.output<typeof Schema>`) so consumers reading
 *     `result.error.traceId` always see the codec runtime value when
 *     the field is set — never a `ZodError` or a wire-shape leak.
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
  // is negligible next to the network round-trip.
  //
  // The wrapper carries a `TResponseStyle` generic that flows through
  // to the `WrapPassThrough<...>` return-type alias — same threading
  // the error-widening wrappers do via `WrapErrors<...>`. The raw SDK
  // function's return type is 3-generic (`RequestResult<TData, _,
  // ThrowOnError>`) so we cast through `Awaited<WrapPassThrough<...>>`
  // to expose the 'data' / 'fields' shape conditional. Both call
  // shapes are structurally compatible with what hey-api emits at
  // runtime; the cast just gives the consumer's call site the right
  // static narrow when they pin `<true, 'data'>` etc.
  if (!inputSlots && !errorTransformerSymbol) {
    const passthroughOptionsType = dsl
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .type(optionsSymbol as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .generic(dsl.type(opDataSymbol as any))
      .generic('ThrowOnError');
    const wrapPassThroughSymbol = plugin.querySymbol({
      category: 'type',
      resource: 'wrapper-error',
      name: 'WrapPassThrough'
    });
    const responsesSymbol = plugin.querySymbol({
      category: 'type',
      resource: 'operation',
      resourceId: opId,
      role: 'responses'
    });
    let passthroughReturnTypeExpr: unknown | undefined;
    if (wrapPassThroughSymbol) {
      const tDataExpr = responsesSymbol
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          dsl.type(responsesSymbol as any)
        : dsl.type('unknown');
      passthroughReturnTypeExpr = dsl
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .type(wrapPassThroughSymbol as any)
        .generic(tDataExpr)
        .generic('ThrowOnError')
        .generic('TResponseStyle');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const styleUnion = (dsl.type.or as (...args: any[]) => unknown)(
      dsl.type.literal('fields'),
      dsl.type.literal('data')
    );
    plugin.node(
      dsl
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .const(wrapperSymbol as any)
        .export()
        .assign(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ((): any => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let f: any = dsl
              .func()
              .async()
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .generic('ThrowOnError', (g: any) => g.extends('boolean').default(false))
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .generic('TResponseStyle', (g: any) =>
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (g as any).extends(styleUnion).default(dsl.type.literal('fields'))
              )
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .param('options', (p: any) =>
                p.required(optionsRequired).type(passthroughOptionsType)
              );
            if (passthroughReturnTypeExpr) {
              f = f.returns(passthroughReturnTypeExpr);
              const awaited = dsl
                .type('Awaited')
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .generic(passthroughReturnTypeExpr as any);
              return f.do(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (dsl as any).return(
                  dsl.as(
                    dsl.as(
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      (dsl(sdkSymbol as any).call('options') as any).await(),
                      dsl.type('unknown')
                    ),
                    awaited
                  )
                )
              );
            }
            return f.do(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (dsl(sdkSymbol as any).call('options') as any).await().return()
            );
          })()
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
  // `Options<TData, ThrowOnError>` from the SDK plugin's
  // `sdk.gen.ts` is a 3-generic alias that drops the upstream
  // `TResponseStyle` slot. The wrapper still threads `TResponseStyle`
  // through its outer generic into `WrapErrors`; runtime selection of
  // the style happens via `options.responseStyle` (or
  // `client.setConfig({ responseStyle })`), which exists on the
  // options shape at runtime even though the 3-arg type signature
  // doesn't surface it. Callers pin the generic at the call site to
  // get the narrowed return shape:
  //
  //   await getX<true, 'data'>({ responseStyle: 'data' });
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
    const transportSymbol = plugin.querySymbol({
      category: 'class',
      resource: 'wrapper-error',
      name: 'TransportError'
    });
    const responseValidationSymbol = plugin.querySymbol({
      category: 'class',
      resource: 'wrapper-error',
      name: 'ResponseValidationError'
    });
    if (!transportSymbol || !responseValidationSymbol) {
      throw new Error(
        `[zod-to-openapi-heyapi] wrapper-error classes missing for '${opId}' — ` +
          `ensureWrapperErrorClasses() should have run by now. Plugin bug.`
      );
    }

    // `result` is declared with `let` outside the try so the body that
    // follows the catch can read it (a block-scoped `const result`
    // inside the try would be unreachable). The inner `try` assigns it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bodyStatements.push((dsl as any).let('result'));

    // throwOnError: true path. The SDK function threw — could be:
    //   (a) the wire-shape error body for an HTTP error response, or
    //   (b) a native Error from fetch (TypeError / AbortError / Node
    //       SystemError carrying ECONNRESET / ETIMEDOUT / etc.) when
    //       the request never produced an HTTP response.
    //
    // Branch on `err instanceof Error`: case (b) wraps as
    // TransportError and re-throws — never runs through parseAsync
    // because there's no HTTP body to validate. Case (a) attempts
    // parseAsync; on success throws the typed `${Op}Error` shape; on
    // validation failure wraps the ZodError plus the wire body in an
    // ResponseValidationError.
    //
    // `instanceof Error` is reliable here: fetch's transport rejections
    // are `TypeError` / `AbortError` / Node `SystemError`, all of which
    // extend the global `Error` constructor in the realm where the
    // wrapper runs (same realm as the fetch call, by definition of an
    // SDK call). A wire-shape error body parsed by hey-api is a plain
    // object — not an Error instance. The earlier `'stack' in err`
    // duck-type was fragile against debug-mode servers (Express /
    // Koa / FastAPI) that include stack traces in JSON error bodies.
    //
    // Result: every throw the wrapper produces is either a typed
    // `${Op}Error` member, a TransportError, or an ResponseValidationError.
    // Consumers narrow via `isTransportError` / `isResponseValidationError`
    // (or `isWrapperError` for "any wrapper-emitted").
    const zodErrorTypeSymbol = plugin.querySymbol({
      category: 'type',
      tool: 'zod',
      name: 'ZodError'
    });
    if (!zodErrorTypeSymbol) {
      throw new Error(`[zod-to-openapi-heyapi] ZodError type symbol missing — plugin bug`);
    }
    bodyStatements.push(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dsl as any)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .try((dsl('result') as any).assign(sdkCallExpr))
        .catchArg('err')
        .catch(
          dsl
            // Wrapper-emitted error → re-throw untouched. The response
            // transformer (run by client-fetch inside the awaited SDK
            // call) throws ResponseValidationError itself when a 2xx
            // body fails validation; without this pass-through the
            // `instanceof Error` branch below would re-wrap it as a
            // TransportError, misreporting a schema violation as a
            // network failure. Marker check, not `instanceof` — same
            // cross-realm reasoning as the emitted guards.
            .if(
              markerCheckExpr(
                () => tsFactory.createIdentifier('err'),
                RESPONSE_VALIDATION_ERROR_SYMBOL_KEY
              )
            )
            .do(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (dsl as any).throw('err', false)
            ),
          dsl
            // err instanceof Error → wrap as TransportError and
            // re-throw, no parseAsync (request never reached the API;
            // nothing to validate).
            .if(instanceofErrorExpr(tsFactory.createIdentifier('err')))
            .do(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (dsl as any).throw(
                dsl
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  .new(transportSymbol as any)
                  .args(
                    dsl.as(
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      dsl('err') as any,
                      dsl.type('Error')
                    )
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ) as any,
                false
              )
            ),
          // err is a plain HTTP-body object → try parseAsync, wrap on
          // validation failure.
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
            .catchArg('validationError')
            .catch(
              // throw new ResponseValidationError(validationError as ZodError, err)
              // — the ZodError carries the parseAsync issues and the
              // original wire body sits alongside as a separate field.
              // Two-arg constructor (rather than mutating the ZodError
              // in place to graft on `.cause`) keeps the body access
              // symmetric: `transportError.cause` and
              // `unknownError.body` are both one hop away.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (dsl as any).throw(
                dsl
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  .new(responseValidationSymbol as any)
                  .args(
                    dsl.as(
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      dsl('validationError') as any,
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      dsl.type(zodErrorTypeSymbol as any)
                    ),
                    dsl.id('err')
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ) as any,
                false
              )
            ),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (dsl as any).throw('typedErr', false)
        )
    );

    // throwOnError: false path — `result` is set; `result.error` may
    // hold a wire body (HTTP error) or a native Error (transport).
    // Cast through `{ error?: unknown }` to satisfy TS's
    // discriminated-union access, then mutate in place: transport →
    // TransportError, plain object → typed shape (parseAsync) or
    // ResponseValidationError (parseAsync rejects). The wrapper's static return
    // type widens `error` to `${Op}Error | TransportError |
    // ResponseValidationError` so consumers see the three cases.
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
      // Gate the wrapper-error logic on the full 'fields'-style shape:
      // `typeof result === 'object' && result !== null &&
      // 'request' in result && 'response' in result &&
      // typeof result.error === 'object' && result.error !== null`.
      //
      // The `request` / `response` presence pair discriminates hey-api's
      // 'fields' response from its 'data' response: hey-api always
      // emits both keys on the fields-style object (regardless of
      // success vs error), and never on the data-style return (which
      // is either the flat payload or `undefined`). The `data` / `error`
      // keys are NOT a reliable discriminator — hey-api omits the
      // unused half of the pair at runtime (the error path returns
      // `{ error, request, response }` with no `data` key, and the
      // success path returns `{ data, request, response }` with no
      // `error` key).
      //
      // The stricter `typeof === 'object' && !== null` check on
      // `result.error` itself defends against hostile primitive values
      // (`error: 0`, `error: ''`, `error: false`) that would fall
      // through to `parseAsync(<prim>)` and mis-classify as a
      // ResponseValidationError despite there being no real failure.
      // `null` is excluded explicitly because `typeof null === 'object'`.
      dsl
        .if(
          // The whole mutation block is additionally gated on the error
          // NOT already being a wrapper-emitted ResponseValidationError:
          // under throwOnError: false, client-fetch catches the response
          // transformer's throw and hands it back as `result.error`, and
          // re-wrapping it as a TransportError (it IS an `instanceof
          // Error`) would misreport a 2xx schema violation as a network
          // failure. Pass it through untouched instead.
          tsFactory.createBinaryExpression(
            tsFactory.createBinaryExpression(
              tsFactory.createBinaryExpression(
                tsFactory.createBinaryExpression(
                  tsFactory.createBinaryExpression(
                    tsFactory.createBinaryExpression(
                      tsFactory.createTypeOfExpression(tsFactory.createIdentifier('result')),
                      tsFactory.createToken(SyntaxKind.EqualsEqualsEqualsToken),
                      tsFactory.createStringLiteral('object')
                    ),
                    tsFactory.createToken(SyntaxKind.AmpersandAmpersandToken),
                    tsFactory.createBinaryExpression(
                      tsFactory.createIdentifier('result'),
                      tsFactory.createToken(SyntaxKind.ExclamationEqualsEqualsToken),
                      tsFactory.createNull()
                    )
                  ),
                  tsFactory.createToken(SyntaxKind.AmpersandAmpersandToken),
                  tsFactory.createBinaryExpression(
                    tsFactory.createStringLiteral('request'),
                    tsFactory.createToken(SyntaxKind.InKeyword),
                    tsFactory.createIdentifier('result')
                  )
                ),
                tsFactory.createToken(SyntaxKind.AmpersandAmpersandToken),
                tsFactory.createBinaryExpression(
                  tsFactory.createStringLiteral('response'),
                  tsFactory.createToken(SyntaxKind.InKeyword),
                  tsFactory.createIdentifier('result')
                )
              ),
              tsFactory.createToken(SyntaxKind.AmpersandAmpersandToken),
              tsFactory.createBinaryExpression(
                tsFactory.createBinaryExpression(
                  tsFactory.createTypeOfExpression(
                    tsFactory.createPropertyAccessExpression(
                      tsFactory.createIdentifier('errorBearing'),
                      'error'
                    )
                  ),
                  tsFactory.createToken(SyntaxKind.EqualsEqualsEqualsToken),
                  tsFactory.createStringLiteral('object')
                ),
                tsFactory.createToken(SyntaxKind.AmpersandAmpersandToken),
                tsFactory.createBinaryExpression(
                  tsFactory.createPropertyAccessExpression(
                    tsFactory.createIdentifier('errorBearing'),
                    'error'
                  ),
                  tsFactory.createToken(SyntaxKind.ExclamationEqualsEqualsToken),
                  tsFactory.createNull()
                )
              )
            ),
            tsFactory.createToken(SyntaxKind.AmpersandAmpersandToken),
            tsFactory.createPrefixUnaryExpression(
              SyntaxKind.ExclamationToken,
              tsFactory.createParenthesizedExpression(
                markerCheckExpr(
                  () =>
                    tsFactory.createPropertyAccessExpression(
                      tsFactory.createIdentifier('errorBearing'),
                      'error'
                    ),
                  RESPONSE_VALIDATION_ERROR_SYMBOL_KEY
                )
              )
            )
          )
        )
        .do(
          dsl
            .if(
              instanceofErrorExpr(
                tsFactory.createPropertyAccessExpression(
                  tsFactory.createIdentifier('errorBearing'),
                  'error'
                )
              )
            )
            .do(
              dsl('errorBearing')
                .attr('error')
                .assign(
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  dsl.new(transportSymbol as any).args(
                    dsl.as(
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      dsl('errorBearing').attr('error') as any,
                      dsl.type('Error')
                    )
                  )
                )
            )
            .otherwise(
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
                .catchArg('validationError')
                .catch(
                  // errorBearing.error = new ResponseValidationError(
                  //   validationError as ZodError,
                  //   errorBearing.error
                  // );
                  // The right-hand-side reads `errorBearing.error`
                  // (the wire body) BEFORE the assignment overwrites
                  // it, so the body is preserved on the ResponseValidationError
                  // even though we're mutating in place. Two-arg
                  // constructor avoids the in-place ZodError mutation
                  // that the earlier `Object.assign(...)` patch used.
                  dsl('errorBearing')
                    .attr('error')
                    .assign(
                      dsl
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        .new(responseValidationSymbol as any)
                        .args(
                          dsl.as(
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            dsl('validationError') as any,
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            dsl.type(zodErrorTypeSymbol as any)
                          ),
                          dsl('errorBearing').attr('error')
                        )
                    )
                )
            )
        )
    );

    // The bodyStatements `return result` is pushed below, after we've
    // constructed `wrapperReturnTypeExpr` — the cast at the return
    // point bridges the SDK's `RequestResult<...>` type to our
    // narrower `WrapErrors<...>`. The two are structurally equivalent
    // for the runtime values we produce, but TS doesn't unify two
    // conditional-type aliases automatically. The cast is internal to
    // the generated wrapper; consumers see only the widened return
    // type and don't need any cast themselves.
  } else {
    // No error transformer — return the SDK call directly.
    bodyStatements.push(sdkCallExpr.return());
  }

  // Explicit return type when the wrapper widens errors at runtime
  // (i.e. `errorTransformerSymbol` is set). Without this, the wrapper's
  // inferred return matches the SDK's return type EXACTLY and the
  // runtime mutation to `TransportError` / `ResponseValidationError` is invisible
  // to TS — a consumer reading `result.error.code` after a malformed
  // response gets `undefined` at runtime with no compile-time hint to
  // narrow first. The annotation forces the three-branch narrow.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let wrapperReturnTypeExpr: any | undefined;
  if (errorTransformerSymbol) {
    const wrapErrorsSymbol = plugin.querySymbol({
      category: 'type',
      resource: 'wrapper-error',
      name: 'WrapErrors'
    });
    const responsesSymbol = plugin.querySymbol({
      category: 'type',
      resource: 'operation',
      resourceId: opId,
      role: 'responses'
    });
    const errorsSymbol = plugin.querySymbol({
      category: 'type',
      resource: 'operation',
      resourceId: opId,
      role: 'errors'
    });
    if (!wrapErrorsSymbol || !errorsSymbol) {
      throw new Error(
        `[zod-to-openapi-heyapi] missing required symbols for return-type ` +
          `widening on '${opId}': WrapErrors=${!!wrapErrorsSymbol}, ` +
          `Errors=${!!errorsSymbol}. Plugin bug.`
      );
    }
    // WrapErrors<${Op}Responses | unknown, ${Op}Errors, ThrowOnError, TResponseStyle>.
    // For errors-only ops (no 2xx schemas registered), `${Op}Responses`
    // doesn't exist; substitute `unknown` so RequestResult's flattening
    // still works (`unknown extends Record<string, unknown> ? … : unknown`
    // → `unknown`).
    //
    // `TResponseStyle` threads through from the wrapper's generic to
    // `WrapErrors`, which conditionally picks between the 'fields' and
    // 'data' return shapes — keeping the wrapper's static return in
    // step with hey-api's runtime in both styles.
    const tDataExpr = responsesSymbol
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dsl.type(responsesSymbol as any)
      : dsl.type('unknown');
    wrapperReturnTypeExpr = dsl
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .type(wrapErrorsSymbol as any)
      .generic(tDataExpr)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .generic(dsl.type(errorsSymbol as any))
      .generic('ThrowOnError')
      .generic('TResponseStyle');

    // `return result as unknown as Awaited<WrapErrors<...>>` — the
    // cast bridges the SDK's `RequestResult<...>` type to our
    // narrower `WrapErrors<...>` annotation. Both shapes are
    // structurally equivalent for the runtime values we produce, but
    // TS doesn't unify two distinct conditional-type aliases by
    // structure alone (TS2352 "neither type sufficiently overlaps").
    // The intermediate `as unknown` satisfies that overlap check.
    // The cast is internal to the generated wrapper; consumers see
    // only the widened return type — they don't write any cast.
    const awaitedReturnType = dsl
      .type('Awaited')

      .generic(wrapperReturnTypeExpr);
    bodyStatements.push(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dsl as any).return(dsl.as(dsl.as(dsl('result'), dsl.type('unknown')), awaitedReturnType))
    );
  }

  plugin.node(
    dsl
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .const(wrapperSymbol as any)
      .export()
      .assign(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((): any => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const styleUnion = (dsl.type.or as (...args: any[]) => unknown)(
            dsl.type.literal('fields'),
            dsl.type.literal('data')
          );
          let f = dsl
            .func()
            .async()
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .generic('ThrowOnError', (g: any) => g.extends('boolean').default(false))
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .generic('TResponseStyle', (g: any) =>
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (g as any).extends(styleUnion).default(dsl.type.literal('fields'))
            )
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .param('options', (p: any) => p.required(optionsRequired).type(optionsTypeExpr));
          if (wrapperReturnTypeExpr) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            f = (f as any).returns(wrapperReturnTypeExpr);
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (f as any).do(...(bodyStatements as any[]));
        })()
      )
  );
}

// ── Wrapper-emitted error classes ────────────────────────────────────────────

// Discriminator marker keys. `Symbol.for(...)` so the same symbol is
// returned from the global registry regardless of which module copy
// of the generated client is loaded — unlike `instanceof`, which
// breaks across realm / iframe / worker / multi-bundle boundaries.
// Mirrors the `@polygonlabs/verror` pattern (WERROR_SYMBOL,
// MULTIERROR_SYMBOL).
const TRANSPORT_ERROR_SYMBOL_KEY = '@polygonlabs/zod-to-openapi-heyapi/is-transport-error';
const RESPONSE_VALIDATION_ERROR_SYMBOL_KEY =
  '@polygonlabs/zod-to-openapi-heyapi/is-response-validation-error';

/**
 * Emit `TransportError` and `ResponseValidationError` classes plus matching
 * `isTransportError` / `isResponseValidationError` helpers in
 * `registry-validator.gen.ts`. Also registers the type-only `ZodError`
 * import from `'zod'` that `ResponseValidationError`'s cause field references.
 *
 * The two classes split the world by **whether the request reached the
 * API at all**:
 *
 *   - **TransportError** — request never produced an HTTP response.
 *     Underlying `cause` is whatever `fetch` threw: a `TypeError`
 *     ("Failed to fetch", DNS failure), an `AbortError`, or a Node
 *     `SystemError` carrying `.code === 'ECONNRESET'` /
 *     `'ETIMEDOUT'` / `'ENOTFOUND'`. The body of an HTTP response was
 *     never seen, so there is nothing to validate against the
 *     registered schema — the wrapper deliberately does NOT run
 *     `parseAsync` on these. Wrapping (rather than passing the raw
 *     native error through) gives consumers a uniform tag-based
 *     discriminator so they don't have to `instanceof` at every call
 *     site.
 *
 *   - **ResponseValidationError** — request produced an HTTP response, but the
 *     body did not match any registered error schema. Could be schema
 *     drift (server bug, stale spec), a foreign error from a CDN /
 *     gateway / proxy that doesn't speak our schema, or any other
 *     "got bytes, can't decode" case the runtime can't tell apart.
 *     The underlying `cause` is the `ZodError` from `parseAsync`; that
 *     `ZodError`'s own `cause` carries the original wire body so a
 *     consumer that wants to debug can walk the chain.
 *
 * Together they let the consumer narrow `result.error` (or the thrown
 * value, on `throwOnError: true`) into one of three cases via a
 * tag-equality check — typed `${Op}Error`, `TransportError`, or
 * `ResponseValidationError` — without ever needing `instanceof` at the call site.
 */
function emitWrapperErrorClasses({ dsl, plugin }: { dsl: Dsl; plugin: PluginLike }): void {
  // ZodError type import — used in ResponseValidationError's `cause` field.
  plugin.symbol('ZodError', {
    external: 'zod',
    importKind: 'named',
    kind: 'type',
    meta: { category: 'type', tool: 'zod', name: 'ZodError' }
  });

  const transportSymbol = plugin.symbol('TransportError', {
    meta: { category: 'class', resource: 'wrapper-error', name: 'TransportError' }
  });
  const responseValidationSymbol = plugin.symbol('ResponseValidationError', {
    meta: { category: 'class', resource: 'wrapper-error', name: 'ResponseValidationError' }
  });
  const zodErrorSymbol = plugin.querySymbol({
    category: 'type',
    tool: 'zod',
    name: 'ZodError'
  });
  if (!zodErrorSymbol) {
    throw new Error(`[zod-to-openapi-heyapi] failed to register ZodError import — plugin bug`);
  }

  // export class TransportError extends Error {
  //   readonly [Symbol.for('@polygonlabs/zod-to-openapi-heyapi/is-transport-error')] = true;
  //   readonly cause: Error;
  //   constructor(cause: Error) {
  //     super('Request failed before producing an HTTP response', { cause });
  //     this.cause = cause;
  //     this.name = 'TransportError';
  //   }
  // }
  //
  // The marker key is inlined as a `Symbol.for(...)` call rather than
  // declared as an exported `unique symbol` const. Three reasons:
  //
  //   - `Symbol.for(KEY)` returns the same symbol globally regardless
  //     of which module copy of the generated client is loaded — same
  //     property `instanceof` would have given us if it worked across
  //     realms / iframes / workers / multi-bundle boundaries.
  //   - Inline literals avoid the hey-api symbol-finalName-resolution
  //     dance: a `dsl.lazy(...)` thunk that needs to reference a const
  //     symbol's binding name fails during the analyze pass because
  //     finalName isn't determined yet.
  //   - Consumers narrow via the emitted `isTransportError` /
  //     `isResponseValidationError` helpers, not by importing the symbol const.
  //     The const would have been a power-user escape hatch for
  //     hand-rolled narrowing — a small cost compared with a plumbing
  //     workaround.
  emitWrapperErrorClass({
    dsl,
    plugin,
    classSymbol: transportSymbol,
    className: 'TransportError',
    markerKey: TRANSPORT_ERROR_SYMBOL_KEY,
    superMessage: 'Request failed before producing an HTTP response',
    causeTypeExpr: dsl.type('Error'),
    jsdoc: [
      '@internal — emitted by `@polygonlabs/zod-to-openapi-heyapi`. Do not',
      'instantiate from consumer code; the wrapper constructs these in',
      'response to fetch transport rejections (DNS / abort / `ECONNRESET`).',
      'Narrow via the emitted `isTransportError` type-predicate guard.'
    ]
  });
  emitWrapperErrorClass({
    dsl,
    plugin,
    classSymbol: responseValidationSymbol,
    className: 'ResponseValidationError',
    markerKey: RESPONSE_VALIDATION_ERROR_SYMBOL_KEY,
    superMessage: 'API response did not match the registered schema',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    causeTypeExpr: dsl.type(zodErrorSymbol as any),
    extraField: {
      name: 'body',
      typeExpr: dsl.type('unknown')
    },
    jsdoc: [
      '@internal — emitted by `@polygonlabs/zod-to-openapi-heyapi`. Do not',
      'instantiate from consumer code; the wrapper constructs these when',
      '`parseAsync` rejects an HTTP error body that did not match any',
      'registered error schema. `cause` carries the `ZodError` issues;',
      '`body` is the original wire body for debugging schema drift.',
      'Narrow via the emitted `isResponseValidationError` type-predicate guard.'
    ]
  });

  // export const isTransportError = (value: unknown): value is TransportError => …
  // export const isResponseValidationError   = (value: unknown): value is ResponseValidationError   => …
  emitTagGuard({
    dsl,
    plugin,
    name: 'isTransportError',
    className: 'TransportError',
    markerKey: TRANSPORT_ERROR_SYMBOL_KEY
  });
  emitTagGuard({
    dsl,
    plugin,
    name: 'isResponseValidationError',
    className: 'ResponseValidationError',
    markerKey: RESPONSE_VALIDATION_ERROR_SYMBOL_KEY
  });
  // export const isWrapperError = (value): value is TransportError | ResponseValidationError => …
  // The "is this any wrapper-emitted error" guard, for consumers that
  // want to log / track the two categories generically without
  // double-checking each tag.
  emitUnionTagGuard({
    dsl,
    plugin,
    name: 'isWrapperError',
    classNames: ['TransportError', 'ResponseValidationError'],
    markerKeys: [TRANSPORT_ERROR_SYMBOL_KEY, RESPONSE_VALIDATION_ERROR_SYMBOL_KEY]
  });

  // type WrapErrors<
  //   TData,
  //   TError,
  //   ThrowOnError extends boolean,
  //   TResponseStyle extends 'fields' | 'data' = 'fields'
  // > = ThrowOnError extends true
  //   ? Promise<
  //       TResponseStyle extends 'data'
  //         ? (TData extends Record<string, unknown> ? TData[keyof TData] : TData)
  //         : {
  //             data: TData extends Record<string, unknown> ? TData[keyof TData] : TData;
  //             request: Request;
  //             response: Response;
  //           }
  //     >
  //   : Promise<
  //       TResponseStyle extends 'data'
  //         ? (TData extends Record<string, unknown> ? TData[keyof TData] : TData) | undefined
  //         : (
  //             | {
  //                 data: TData extends Record<string, unknown> ? TData[keyof TData] : TData;
  //                 error: undefined;
  //               }
  //             | {
  //                 data: undefined;
  //                 error:
  //                   | (TError extends Record<string, unknown> ? TError[keyof TError] : TError)
  //                   | TransportError
  //                   | ResponseValidationError;
  //               }
  //           ) & {
  //             request: Request;
  //             response: Response;
  //           }
  //     >;
  //
  // Mirrors hey-api's `RequestResult<TData, TError, ThrowOnError, TResponseStyle>`
  // shape with the wrapper-error classes added to the error union. Defined
  // locally rather than imported from the consumer's generated client
  // because the client's import path varies by hey-api config (`./client.gen.ts`
  // vs `./client/index.ts` etc.) — owning the shape here keeps the wrapper's
  // return-type contract self-contained.
  //
  // The 'data' style adds nothing to the error union in the no-throw
  // branch: hey-api's runtime returns `undefined` for the error path in
  // 'data' style, so there's no slot to attach `TransportError` /
  // `ResponseValidationError` to. Consumers using 'data' style + throw
  // mode catch wrapper-emitted errors in their `catch` block where the
  // value is `unknown` and the codegen-emitted predicates narrow it.
  emitWrapErrorsAlias({ dsl, plugin });
}

/**
 * Emit the `WrapPassThrough<TData, ThrowOnError, TResponseStyle>` type
 * alias at file scope. Mirrors hey-api's `RequestResult<TData, never,
 * ThrowOnError, TResponseStyle>` shape — the pass-through siblings of
 * the error-widening wrappers use this when they have no declared
 * error schemas (no `TError` generic; no wrapper-error union on the
 * error path; the error type collapses to `unknown` since the route
 * can return any HTTP body on the error path).
 *
 * Hand-built parallel to {@link emitWrapErrorsAlias} so pass-through
 * wrappers can still thread `TResponseStyle` through their return
 * type and produce hey-api's 'data' or 'fields' shape per call.
 */
function emitWrapPassThroughAlias({ dsl, plugin }: { dsl: Dsl; plugin: PluginLike }): void {
  const aliasSymbol = plugin.symbol('WrapPassThrough', {
    kind: 'type',
    meta: { category: 'type', resource: 'wrapper-error', name: 'WrapPassThrough' }
  });

  const TData = tsFactory.createTypeReferenceNode('TData');
  const ThrowOnError = tsFactory.createTypeReferenceNode('ThrowOnError');
  const TResponseStyle = tsFactory.createTypeReferenceNode('TResponseStyle');
  const RecordStringUnknown = tsFactory.createTypeReferenceNode('Record', [
    tsFactory.createKeywordTypeNode(SyntaxKind.StringKeyword),
    tsFactory.createKeywordTypeNode(SyntaxKind.UnknownKeyword)
  ]);
  const dataLiteral = tsFactory.createLiteralTypeNode(tsFactory.createStringLiteral('data'));
  const fieldsOrDataUnion = tsFactory.createUnionTypeNode([
    tsFactory.createLiteralTypeNode(tsFactory.createStringLiteral('fields')),
    dataLiteral
  ]);

  const flattenedData = tsFactory.createConditionalTypeNode(
    TData,
    RecordStringUnknown,
    tsFactory.createIndexedAccessTypeNode(
      TData,
      tsFactory.createTypeOperatorNode(SyntaxKind.KeyOfKeyword, TData)
    ),
    TData
  );

  const requestField = tsFactory.createPropertySignature(
    undefined,
    'request',
    undefined,
    tsFactory.createTypeReferenceNode('Request')
  );
  const responseField = tsFactory.createPropertySignature(
    undefined,
    'response',
    undefined,
    tsFactory.createTypeReferenceNode('Response')
  );
  const requestResponseLiteral = tsFactory.createTypeLiteralNode([requestField, responseField]);

  // Throw branch: 'data' → flat; 'fields' → { data; request; response }
  const throwFieldsBranch = tsFactory.createTypeLiteralNode([
    tsFactory.createPropertySignature(undefined, 'data', undefined, flattenedData),
    requestField,
    responseField
  ]);
  const throwBranch = tsFactory.createConditionalTypeNode(
    TResponseStyle,
    dataLiteral,
    flattenedData,
    throwFieldsBranch
  );

  // No-throw branch: 'data' → TData | undefined;
  // 'fields' → discriminated union with bare unknown error (no
  // wrapper-error union — pass-throughs don't wrap).
  const noThrowDataBranch = tsFactory.createUnionTypeNode([
    flattenedData,
    tsFactory.createKeywordTypeNode(SyntaxKind.UndefinedKeyword)
  ]);
  const okMember = tsFactory.createTypeLiteralNode([
    tsFactory.createPropertySignature(undefined, 'data', undefined, flattenedData),
    tsFactory.createPropertySignature(
      undefined,
      'error',
      undefined,
      tsFactory.createKeywordTypeNode(SyntaxKind.UndefinedKeyword)
    )
  ]);
  const errorMember = tsFactory.createTypeLiteralNode([
    tsFactory.createPropertySignature(
      undefined,
      'data',
      undefined,
      tsFactory.createKeywordTypeNode(SyntaxKind.UndefinedKeyword)
    ),
    tsFactory.createPropertySignature(
      undefined,
      'error',
      undefined,
      tsFactory.createKeywordTypeNode(SyntaxKind.UnknownKeyword)
    )
  ]);
  const noThrowFieldsBranch = tsFactory.createIntersectionTypeNode([
    tsFactory.createParenthesizedType(tsFactory.createUnionTypeNode([okMember, errorMember])),
    requestResponseLiteral
  ]);
  const noThrowBranch = tsFactory.createConditionalTypeNode(
    TResponseStyle,
    dataLiteral,
    noThrowDataBranch,
    noThrowFieldsBranch
  );

  const conditional = tsFactory.createTypeReferenceNode('Promise', [
    tsFactory.createConditionalTypeNode(
      ThrowOnError,
      tsFactory.createLiteralTypeNode(tsFactory.createTrue()),
      throwBranch,
      noThrowBranch
    )
  ]);

  plugin.node(
    dsl.type
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .alias(aliasSymbol as any)
      .export()
      .generic('TData')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .generic('ThrowOnError', (g: any) => g.extends('boolean'))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .generic('TResponseStyle', (g: any) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (g as any).extends(fieldsOrDataUnion).default(dsl.type.literal('fields'))
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .type(conditional as any)
  );
}

/**
 * Emit the `WrapErrors<TData, TError, ThrowOnError, TResponseStyle>`
 * type alias at file scope. Mirrors hey-api's
 * `RequestResult<TData, TError, ThrowOnError, TResponseStyle>` shape
 * with `TransportError | ResponseValidationError` added to the
 * `'fields'` error union — single source of truth for the wrapper
 * return type.
 *
 * Hand-built via raw `tsFactory`: nested conditional types, type
 * literals, intersection / union, and infer-style record-flattening
 * are awkward to thread through the openapi-ts DSL builder, and the
 * shape is static enough that the `tsFactory` form reads cleaner.
 *
 * `'data'` style doesn't get a wrapper-error union in the no-throw
 * branch because hey-api's runtime returns plain `undefined` on the
 * error path in `'data'` mode — there's no `error` field to attach
 * the wrapper classes to. Consumers using `'data'` with
 * `throwOnError: true` catch wrapper errors in their `catch` block
 * (the codegen-emitted `is*Error` predicates narrow the caught
 * `unknown`).
 */
function emitWrapErrorsAlias({ dsl, plugin }: { dsl: Dsl; plugin: PluginLike }): void {
  const aliasSymbol = plugin.symbol('WrapErrors', {
    kind: 'type',
    meta: { category: 'type', resource: 'wrapper-error', name: 'WrapErrors' }
  });

  const TData = tsFactory.createTypeReferenceNode('TData');
  const TError = tsFactory.createTypeReferenceNode('TError');
  const ThrowOnError = tsFactory.createTypeReferenceNode('ThrowOnError');
  const TResponseStyle = tsFactory.createTypeReferenceNode('TResponseStyle');
  const RecordStringUnknown = tsFactory.createTypeReferenceNode('Record', [
    tsFactory.createKeywordTypeNode(SyntaxKind.StringKeyword),
    tsFactory.createKeywordTypeNode(SyntaxKind.UnknownKeyword)
  ]);
  const dataLiteral = tsFactory.createLiteralTypeNode(tsFactory.createStringLiteral('data'));
  const fieldsOrDataUnion = tsFactory.createUnionTypeNode([
    tsFactory.createLiteralTypeNode(tsFactory.createStringLiteral('fields')),
    dataLiteral
  ]);

  // TData extends Record<string, unknown> ? TData[keyof TData] : TData
  const flattenedData = tsFactory.createConditionalTypeNode(
    TData,
    RecordStringUnknown,
    tsFactory.createIndexedAccessTypeNode(
      TData,
      tsFactory.createTypeOperatorNode(SyntaxKind.KeyOfKeyword, TData)
    ),
    TData
  );
  // TError extends Record<string, unknown> ? TError[keyof TError] : TError
  const flattenedError = tsFactory.createConditionalTypeNode(
    TError,
    RecordStringUnknown,
    tsFactory.createIndexedAccessTypeNode(
      TError,
      tsFactory.createTypeOperatorNode(SyntaxKind.KeyOfKeyword, TError)
    ),
    TError
  );

  // request / response field signatures, shared.
  const requestField = tsFactory.createPropertySignature(
    undefined,
    'request',
    undefined,
    tsFactory.createTypeReferenceNode('Request')
  );
  const responseField = tsFactory.createPropertySignature(
    undefined,
    'response',
    undefined,
    tsFactory.createTypeReferenceNode('Response')
  );
  const requestResponseLiteral = tsFactory.createTypeLiteralNode([requestField, responseField]);

  // ── Throw branch (ThrowOnError extends true) ────────────────────────────────
  //
  // 'data' style: just the flattened data — errors throw.
  // 'fields' style: { data: <flat>; request; response } — errors throw.
  const throwFieldsBranch = tsFactory.createTypeLiteralNode([
    tsFactory.createPropertySignature(undefined, 'data', undefined, flattenedData),
    requestField,
    responseField
  ]);
  const throwBranch = tsFactory.createConditionalTypeNode(
    TResponseStyle,
    dataLiteral,
    flattenedData,
    throwFieldsBranch
  );

  // ── No-throw branch (ThrowOnError extends false) ────────────────────────────
  //
  // 'data' style: <flat data> | undefined — no error slot.
  // 'fields' style: discriminated union with the wrapper-error union
  // added to the error path.
  const noThrowDataBranch = tsFactory.createUnionTypeNode([
    flattenedData,
    tsFactory.createKeywordTypeNode(SyntaxKind.UndefinedKeyword)
  ]);
  const okMember = tsFactory.createTypeLiteralNode([
    tsFactory.createPropertySignature(undefined, 'data', undefined, flattenedData),
    tsFactory.createPropertySignature(
      undefined,
      'error',
      undefined,
      tsFactory.createKeywordTypeNode(SyntaxKind.UndefinedKeyword)
    )
  ]);
  const errorMember = tsFactory.createTypeLiteralNode([
    tsFactory.createPropertySignature(
      undefined,
      'data',
      undefined,
      tsFactory.createKeywordTypeNode(SyntaxKind.UndefinedKeyword)
    ),
    tsFactory.createPropertySignature(
      undefined,
      'error',
      undefined,
      tsFactory.createUnionTypeNode([
        flattenedError,
        tsFactory.createTypeReferenceNode('TransportError'),
        tsFactory.createTypeReferenceNode('ResponseValidationError')
      ])
    )
  ]);
  const noThrowFieldsBranch = tsFactory.createIntersectionTypeNode([
    tsFactory.createParenthesizedType(tsFactory.createUnionTypeNode([okMember, errorMember])),
    requestResponseLiteral
  ]);
  const noThrowBranch = tsFactory.createConditionalTypeNode(
    TResponseStyle,
    dataLiteral,
    noThrowDataBranch,
    noThrowFieldsBranch
  );

  // Promise<ThrowOnError extends true ? <throwBranch> : <noThrowBranch>>
  // Outer Promise wraps both branches so the resolved alias always
  // satisfies TS's "async function return type must be the global
  // Promise<T> type" check (TS1064). Putting the Promise inside each
  // conditional branch is semantically equivalent but trips the
  // syntactic check on the wrapper's return-type annotation.
  const conditional = tsFactory.createTypeReferenceNode('Promise', [
    tsFactory.createConditionalTypeNode(
      ThrowOnError,
      tsFactory.createLiteralTypeNode(tsFactory.createTrue()),
      throwBranch,
      noThrowBranch
    )
  ]);

  // Use TypeAliasTsDsl through the DSL so plugin.node correctly
  // places it at top level. TResponseStyle defaults to 'fields' so
  // existing 3-arg consumer references (`WrapErrors<TData, TError, true>`)
  // keep working without modification.
  plugin.node(
    dsl.type
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .alias(aliasSymbol as any)
      .export()
      .generic('TData')
      .generic('TError')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .generic('ThrowOnError', (g: any) => g.extends('boolean'))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .generic('TResponseStyle', (g: any) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (g as any).extends(fieldsOrDataUnion).default(dsl.type.literal('fields'))
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .type(conditional as any)
  );
}

/**
 * `<subject> instanceof Error` as a raw TS expression — the DSL's
 * `BinaryTsDsl` doesn't expose `instanceof` as an operator, so we
 * drop to `ts.factory`. The DSL's `if(...)` slot accepts a raw
 * `ts.Expression` directly (per its `IfCondition = NodeName |
 * MaybeTsDsl<ts.Expression>` signature), so no DSL wrap is needed.
 *
 * `instanceof Error` is reliable for our discrimination because
 * fetch transport rejections (`TypeError`, `AbortError`, Node
 * `SystemError`) all extend the global `Error`, hey-api's wire-shape
 * error bodies are plain object literals, and the wrapper runs in
 * the same realm as the fetch call. The earlier `'stack' in err`
 * duck-type was fragile against debug-mode servers (Express / Koa /
 * FastAPI) that include stack traces in error JSON.
 */
function instanceofErrorExpr(subject: Expression): Expression {
  return tsFactory.createBinaryExpression(
    subject,
    tsFactory.createToken(SyntaxKind.InstanceOfKeyword),
    tsFactory.createIdentifier('Error')
  );
}

/**
 * `typeof <subject> === 'object' && <subject> !== null &&
 * (<subject> as Record<symbol, unknown>)[Symbol.for(markerKey)] === true`
 *
 * The same cross-realm marker check the emitted type-predicate guards
 * perform, as an inline expression against an arbitrary subject. Used by
 * the SDK wrapper to recognise wrapper-emitted errors (e.g. the
 * ResponseValidationError a response transformer throws on a 2xx body
 * that fails validation) so they pass through instead of being re-wrapped
 * as TransportError. Marker over `instanceof` for the same reasons the
 * guards use it: cross-realm stability and no dependence on class-symbol
 * finalName resolution.
 *
 * `subject` is a factory so each of the three positions gets a fresh
 * node — re-using one TS AST node in several positions has produced
 * double-rendered output in other DSL paths.
 */
function markerCheckExpr(subject: () => Expression, markerKey: string): Expression {
  const typeofObject = tsFactory.createBinaryExpression(
    tsFactory.createTypeOfExpression(subject()),
    tsFactory.createToken(SyntaxKind.EqualsEqualsEqualsToken),
    tsFactory.createStringLiteral('object')
  );
  const notNull = tsFactory.createBinaryExpression(
    subject(),
    tsFactory.createToken(SyntaxKind.ExclamationEqualsEqualsToken),
    tsFactory.createNull()
  );
  const recordType = tsFactory.createTypeReferenceNode('Record', [
    tsFactory.createKeywordTypeNode(SyntaxKind.SymbolKeyword),
    tsFactory.createKeywordTypeNode(SyntaxKind.UnknownKeyword)
  ]);
  const markerEqualsTrue = tsFactory.createBinaryExpression(
    tsFactory.createElementAccessExpression(
      tsFactory.createParenthesizedExpression(tsFactory.createAsExpression(subject(), recordType)),
      symbolForExpr(markerKey)
    ),
    tsFactory.createToken(SyntaxKind.EqualsEqualsEqualsToken),
    tsFactory.createTrue()
  );
  return tsFactory.createBinaryExpression(
    tsFactory.createBinaryExpression(
      typeofObject,
      tsFactory.createToken(SyntaxKind.AmpersandAmpersandToken),
      notNull
    ),
    tsFactory.createToken(SyntaxKind.AmpersandAmpersandToken),
    markerEqualsTrue
  );
}

/** `Symbol.for('<key>')` as a TS expression — the cross-realm anchor. */
function symbolForExpr(key: string): CallExpression {
  return tsFactory.createCallExpression(
    tsFactory.createPropertyAccessExpression(tsFactory.createIdentifier('Symbol'), 'for'),
    undefined,
    [tsFactory.createStringLiteral(key)]
  );
}

/**
 * Shared emit for a wrapper-error class. Each class:
 *
 *   - extends `Error`
 *   - carries a `[Symbol.for(<markerKey>)] = true` discriminator field
 *     (cross-realm safe — same symbol globally regardless of which
 *     module copy of the generated client is loaded)
 *   - narrows `cause` to a specific subtype (`Error` for transport,
 *     `ZodError` for unknown) so consumers can read `error.cause.<field>`
 *     without a cast
 *   - sets `this.name` to the class name for nicer logging
 *   - is documented `@internal` so consumers see a hint not to
 *     instantiate or extend the class themselves — it's a
 *     codegen-emitted marker, not a public surface
 *
 * Optional `extraField` adds a second readonly field + constructor
 * param + assignment (used by `ResponseValidationError` to carry the original
 * wire body alongside the `ZodError` cause).
 */
function emitWrapperErrorClass({
  dsl,
  plugin,
  classSymbol,
  className,
  markerKey,
  superMessage,
  causeTypeExpr,
  extraField,
  jsdoc
}: {
  dsl: Dsl;
  plugin: PluginLike;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  classSymbol: any;
  className: string;
  markerKey: string;
  superMessage: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  causeTypeExpr: any;
  extraField?: {
    name: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    typeExpr: any;
  };
  jsdoc?: ReadonlyArray<string>;
}): void {
  // this[Symbol.for(MARKER_KEY)] = true; — computed-key element
  // access expressed as a raw tsFactory ExpressionStatement, then
  // wrapped in `dsl.stmt(...)` so the surrounding init block can
  // accept it. The DSL's `.attr()` is dot-access only and has no
  // computed-key form. Inline `Symbol.for(KEY)` (rather than a const
  // binding) sidesteps hey-api's symbol-finalName resolution entirely
  // — `Symbol.for` is a global call expression, no registered symbol
  // to resolve.
  // (this as Record<symbol, unknown>)[Symbol.for(MARKER_KEY)] = true;
  // The cast is required: a class doesn't have a symbol index
  // signature, so a bare `this[Symbol.for(...)] = true` triggers
  // TS7053. The cast is read-only on the runtime side — `this` is
  // always the actual instance.
  const recordSymbolUnknown = tsFactory.createTypeReferenceNode('Record', [
    tsFactory.createKeywordTypeNode(SyntaxKind.SymbolKeyword),
    tsFactory.createKeywordTypeNode(SyntaxKind.UnknownKeyword)
  ]);
  const markerAssignmentStmt = dsl.stmt(
    tsFactory.createExpressionStatement(
      tsFactory.createAssignment(
        tsFactory.createElementAccessExpression(
          tsFactory.createParenthesizedExpression(
            tsFactory.createAsExpression(tsFactory.createThis(), recordSymbolUnknown)
          ),
          symbolForExpr(markerKey)
        ),
        tsFactory.createTrue()
      )
    )
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let classBuilder: any = dsl
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .class(classSymbol as any)
    .export()
    .extends('Error');

  if (jsdoc && jsdoc.length > 0) {
    // DocTsDsl `lines` arg accepts `MaybeArray<string>` — pass as
    // an array directly. The callback form (`(d) => d.add(line)`)
    // appears to mis-fire at render time on this hey-api version
    // (`d.add is not a function`); the lines-arg form is the
    // documented entry point and works.
    classBuilder = classBuilder.doc([...jsdoc]);
  }

  classBuilder = classBuilder.field('cause', (f: unknown) =>
    // Declare-and-override `cause` to narrow it from `unknown`
    // (Error's default). The DSL doesn't expose `declare`, so we
    // emit `readonly cause: <T>` as a real field and assign it
    // explicitly in the constructor.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (f as any).readonly().type(causeTypeExpr)
  );

  if (extraField) {
    classBuilder = classBuilder.field(extraField.name, (f: unknown) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (f as any).readonly().type(extraField.typeExpr)
    );
  }

  plugin.node(
    classBuilder.init((i: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let init = (i as any).param('cause', (p: any) => p.type(causeTypeExpr));
      if (extraField) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        init = init.param(extraField.name, (p: any) => p.type(extraField.typeExpr));
      }
      // The constructor body deliberately does NOT pass `{ cause }`
      // to `super(...)`. The class declares a narrower `readonly cause:
      // <T>` field above and assigns it explicitly via
      // `this.cause = cause` here — that single assignment satisfies
      // both the runtime (the value lands on the instance under the
      // canonical name) and TypeScript's strict property
      // initialization. Adding `{ cause }` to `super` would assign the
      // same value twice for no observable benefit.
      const stmts: unknown[] = [
        dsl('super').call(dsl.literal(superMessage)),
        markerAssignmentStmt,
        dsl('this').attr('cause').assign(dsl.id('cause')),
        dsl('this').attr('name').assign(dsl.literal(className))
      ];
      if (extraField) {
        stmts.push(dsl('this').attr(extraField.name).assign(dsl.id(extraField.name)));
      }
      return init.do(...stmts);
    })
  );
}

/**
 * Emit a type-guard helper:
 *
 *   export const isTransportError = (value: unknown): value is TransportError =>
 *     typeof value === 'object' && value !== null &&
 *     (value as Record<symbol, unknown>)[
 *       Symbol.for('@polygonlabs/zod-to-openapi-heyapi/is-transport-error')
 *     ] === true;
 *
 * The DSL doesn't expose type predicates (`value is TransportError`)
 * as a first-class node, so the arrow function is hand-constructed
 * via `tsFactory` and emitted as a top-level VariableStatement
 * wrapped in `dsl.stmt(...)`.
 *
 * `className` is captured by string rather than by hey-api Symbol
 * reference because the lazy/Symbol-resolution dance fails during
 * the analyze pass (finalName isn't available yet). In practice the
 * class binding names we emit (`TransportError` / `ResponseValidationError`)
 * are stable — they only get suffix-renamed on collision, and a
 * collision with a user schema named `TransportError` would already
 * have broken the consumer's import surface elsewhere.
 *
 * The body uses literal-driven shape checks (no `instanceof`) so it
 * stays cross-realm safe: a class constructor copy loaded from a
 * different module bundle won't pass `instanceof`, but the global
 * symbol from `Symbol.for(...)` is identity-stable across module
 * copies and realms.
 */
function emitTagGuard({
  dsl,
  plugin,
  name,
  className,
  markerKey
}: {
  dsl: Dsl;
  plugin: PluginLike;
  name: string;
  className: string;
  markerKey: string;
}): void {
  const guardSymbol = plugin.symbol(name, {
    meta: { category: 'utility', resource: 'wrapper-error', name }
  });

  // (value: unknown): value is <Class> => …
  const valueParam = tsFactory.createParameterDeclaration(
    undefined,
    undefined,
    'value',
    undefined,
    tsFactory.createKeywordTypeNode(SyntaxKind.UnknownKeyword)
  );
  const predicate = tsFactory.createTypePredicateNode(
    undefined,
    'value',
    tsFactory.createTypeReferenceNode(className)
  );

  //   typeof value === 'object'
  const typeofObject = tsFactory.createBinaryExpression(
    tsFactory.createTypeOfExpression(tsFactory.createIdentifier('value')),
    SyntaxKind.EqualsEqualsEqualsToken,
    tsFactory.createStringLiteral('object')
  );

  //   value !== null
  const notNull = tsFactory.createBinaryExpression(
    tsFactory.createIdentifier('value'),
    SyntaxKind.ExclamationEqualsEqualsToken,
    tsFactory.createNull()
  );

  //   (value as Record<symbol, unknown>)[Symbol.for(KEY)] === true
  const recordType = tsFactory.createTypeReferenceNode('Record', [
    tsFactory.createKeywordTypeNode(SyntaxKind.SymbolKeyword),
    tsFactory.createKeywordTypeNode(SyntaxKind.UnknownKeyword)
  ]);
  const markerEqualsTrue = tsFactory.createBinaryExpression(
    tsFactory.createElementAccessExpression(
      tsFactory.createParenthesizedExpression(
        tsFactory.createAsExpression(tsFactory.createIdentifier('value'), recordType)
      ),
      symbolForExpr(markerKey)
    ),
    SyntaxKind.EqualsEqualsEqualsToken,
    tsFactory.createTrue()
  );

  // typeof value === 'object' && value !== null && (...)
  const body = tsFactory.createBinaryExpression(
    tsFactory.createBinaryExpression(typeofObject, SyntaxKind.AmpersandAmpersandToken, notNull),
    SyntaxKind.AmpersandAmpersandToken,
    markerEqualsTrue
  );

  const arrow = tsFactory.createArrowFunction(
    undefined,
    undefined,
    [valueParam],
    predicate,
    tsFactory.createToken(SyntaxKind.EqualsGreaterThanToken),
    body
  );

  // `dsl.const(symbol).export().assign(dsl(rawExpression))` — wrap the
  // raw arrow as a TsDsl<Expression> via the `$()` overload that
  // accepts `Expression`. The DSL drives top-level placement +
  // import wiring; the only escape is the arrow expression itself
  // (raw because the type-predicate return annotation isn't a
  // first-class DSL node).
  plugin.node(
    dsl
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .const(guardSymbol as any)
      .export()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .assign(dsl(arrow as unknown as Expression) as any)
  );
}

/**
 * Emit a union type-guard helper:
 *
 *   export const isWrapperError = (value: unknown): value is TransportError | ResponseValidationError =>
 *     typeof value === 'object' && value !== null && (
 *       (value as Record<symbol, unknown>)[Symbol.for(KEY_T)] === true ||
 *       (value as Record<symbol, unknown>)[Symbol.for(KEY_U)] === true
 *     );
 *
 * Same construction as `emitTagGuard` but with multiple markers OR'd
 * together and a union type predicate. Saves consumers writing
 * `isTransportError(x) || isResponseValidationError(x)` at every "log all
 * wrapper errors generically" call site.
 */
function emitUnionTagGuard({
  dsl,
  plugin,
  name,
  classNames,
  markerKeys
}: {
  dsl: Dsl;
  plugin: PluginLike;
  name: string;
  classNames: ReadonlyArray<string>;
  markerKeys: ReadonlyArray<string>;
}): void {
  if (classNames.length !== markerKeys.length || classNames.length === 0) {
    throw new Error(
      `[zod-to-openapi-heyapi] emitUnionTagGuard: classNames and markerKeys ` +
        `must be non-empty and equal length (got ${classNames.length} / ${markerKeys.length})`
    );
  }

  const guardSymbol = plugin.symbol(name, {
    meta: { category: 'utility', resource: 'wrapper-error', name }
  });

  const valueParam = tsFactory.createParameterDeclaration(
    undefined,
    undefined,
    'value',
    undefined,
    tsFactory.createKeywordTypeNode(SyntaxKind.UnknownKeyword)
  );
  // value is TransportError | ResponseValidationError
  const predicate = tsFactory.createTypePredicateNode(
    undefined,
    'value',
    tsFactory.createUnionTypeNode(classNames.map((c) => tsFactory.createTypeReferenceNode(c)))
  );

  const typeofObject = tsFactory.createBinaryExpression(
    tsFactory.createTypeOfExpression(tsFactory.createIdentifier('value')),
    SyntaxKind.EqualsEqualsEqualsToken,
    tsFactory.createStringLiteral('object')
  );
  const notNull = tsFactory.createBinaryExpression(
    tsFactory.createIdentifier('value'),
    SyntaxKind.ExclamationEqualsEqualsToken,
    tsFactory.createNull()
  );

  const recordType = tsFactory.createTypeReferenceNode('Record', [
    tsFactory.createKeywordTypeNode(SyntaxKind.SymbolKeyword),
    tsFactory.createKeywordTypeNode(SyntaxKind.UnknownKeyword)
  ]);
  const markerChecks = markerKeys.map((key) =>
    tsFactory.createBinaryExpression(
      tsFactory.createElementAccessExpression(
        tsFactory.createParenthesizedExpression(
          tsFactory.createAsExpression(tsFactory.createIdentifier('value'), recordType)
        ),
        symbolForExpr(key)
      ),
      SyntaxKind.EqualsEqualsEqualsToken,
      tsFactory.createTrue()
    )
  );
  // OR-fold: a === true || b === true || …
  const [first, ...rest] = markerChecks;
  if (!first) {
    // unreachable (length-check above) but narrows the destructuring
    throw new Error(`[zod-to-openapi-heyapi] emitUnionTagGuard: empty markerChecks`);
  }
  const markerOr = rest.reduce<Expression>(
    (acc, check) => tsFactory.createBinaryExpression(acc, SyntaxKind.BarBarToken, check),
    first
  );

  // Wrap the OR in parens for readable output: `(a || b)` —
  // ts.factory respects parens in BinaryExpression printout already
  // because the `&&` binding is tighter than `||`, but render-wise
  // an explicit parenthesised expression keeps the formatted output
  // visually clear.
  const body = tsFactory.createBinaryExpression(
    tsFactory.createBinaryExpression(typeofObject, SyntaxKind.AmpersandAmpersandToken, notNull),
    SyntaxKind.AmpersandAmpersandToken,
    tsFactory.createParenthesizedExpression(markerOr)
  );

  const arrow = tsFactory.createArrowFunction(
    undefined,
    undefined,
    [valueParam],
    predicate,
    tsFactory.createToken(SyntaxKind.EqualsGreaterThanToken),
    body
  );

  plugin.node(
    dsl
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .const(guardSymbol as any)
      .export()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .assign(dsl(arrow as unknown as Expression) as any)
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
