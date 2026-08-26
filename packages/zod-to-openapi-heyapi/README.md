# @polygonlabs/zod-to-openapi-heyapi

A `@hey-api/openapi-ts` plugin for end-to-end Zod-schema-first API development.
Generated clients import the **actual** Zod schemas the backend uses to
validate the wire — the same schemas a `@asteasolutions/zod-to-openapi`
`OpenAPIRegistry` composed the OpenAPI spec from — instead of re-deriving
them at codegen time.

## Why this package exists

The team writes APIs Zod-schema-first using `@asteasolutions/zod-to-openapi`'s
`OpenAPIRegistry`: Zod schemas describe the wire shape, the registry composes
them into an OpenAPI spec, and the spec drives client codegen. The promise is
end-to-end — backend services validate requests and responses against the
same Zod schemas the spec was generated from, and clients should validate
against those same schemas in turn.

The standard tooling breaks that promise. `@hey-api/zod` produces Zod schemas
by walking the OpenAPI spec — round-tripping `Zod → JSON Schema → Zod`. That
trip is lossy: codecs, refinements, branded types, non-trivial constraints,
and custom error messages don't survive it. The regenerated schemas are
strictly wider than the originals, so the client validates a superset of what
the backend actually accepts. Schema-first becomes schema-twice, and the two
copies drift the moment a constraint changes.

This plugin fixes that by sourcing the actual Zod schemas — the ones that
generated the spec — for the generated client to import. The client and the
service validate identical shapes because they share the schema, not a
reconstruction of it. The [`schemasFrom`](#the-schemasfrom-option) option is
the knob that wires this together — point it at the same module your backend
imports the registered schemas from.

A natural consequence: `z.codec(...)` schemas work correctly. When wire
format and runtime value differ (`Int64Codec`: wire `string`, runtime
`bigint`), the plugin emits `z.output<typeof Schema>` response types and a
runtime `parseAsync` transformer; the fetch client runs the transformer on
every response, so codec decode (`"1500"` → `1500n`, ISO string → `Date`, …)
happens before the value reaches the caller and the type and runtime agree.

[`@polygonlabs/zod-codecs`][codecs] ships the off-the-shelf codecs the team
reaches for (`Int64Codec`, `BigIntegerCodec`, `DecimalStringCodec`,
`IsoDateCodec`); this plugin works with any `z.codec(...)` schema, whether
imported or defined inline.

[codecs]: https://www.npmjs.com/package/@polygonlabs/zod-codecs

## Usage

```ts
import { defineRegistryClientConfig } from '@polygonlabs/zod-to-openapi-heyapi';
import { myRegistry } from './schemas/registry.ts';

export default await defineRegistryClientConfig({
  registry: myRegistry,
  schemasFrom: '@my-org/api-schemas',
  input: './openapi.json',
  output: './src/generated'
});
```

That's the whole config. The factory locks in the plugin order, the
`@hey-api/sdk` flags this plugin requires (`transformer: true`,
`includeInEntry: false`), and the resolution-fragile passthroughs (`$`
and `OpenApiGeneratorV3`) so consumers don't have to wire any of it up
themselves.

It also flips `includeInEntry: true` on `@hey-api/client-fetch` and
(when `tanstackReactQuery: true`) on `@tanstack/react-query`, so the
auto-generated `index.ts` is the **canonical consumer surface**: the
singleton `client`, every SDK wrapper, both wrapper-error classes plus
their `is*Error` guards, and every TanStack Query factory all flow
through `./generated/index.js`. Publishable client packages should
re-export from `./generated/index.js` and never name a `*.gen.ts` path
in their hand-written barrel — the layout (which factory file owns
which op, where the singleton `client` lives) is an internal codegen
concern that consumers shouldn't have to understand.

For codec-aware TanStack Query factories alongside the SDK wrappers,
flip `tanstackReactQuery: true`. See [TanStack Query
factories](#tanstack-query-factories) below for the full picture.
`@tanstack/react-query` is an optional peer dependency — only install
it when you turn the flag on.

### Advanced — composing the plugin yourself

If you need a plugin shape the factory doesn't expose, drop down to
`registryPlugin` and assemble the config by hand. The factory is the
recommended path; the lower-level export is the escape hatch.

```ts
import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { $, defineConfig } from '@hey-api/openapi-ts';
import { registryPlugin } from '@polygonlabs/zod-to-openapi-heyapi';
import { myRegistry } from './schemas/registry.ts';

export default defineConfig({
  input: './openapi.json',
  output: { path: './src/generated', clean: true },
  plugins: [
    // Must be listed BEFORE @hey-api/typescript so the plugin's
    // response-type symbols are registered first; the SDK plugin queries
    // by metadata key and takes the first registered match.
    (await registryPlugin({
      registry: myRegistry,
      schemasFrom: '@my-org/api-schemas',
      generatorClass: OpenApiGeneratorV3,
      $
    })) as never,
    // `includeInEntry: false` here keeps the wire-shape `${Op}Response` /
    // `${Op}Error` aliases out of the auto-barrel — this plugin emits
    // codec-aware aliases under the same names. Without the flag, both
    // land in the entry barrel and hey-api collision-renames the
    // typescript plugin's emissions to `${Name}2` (`CreateOrderError2`,
    // etc.) — reaching for `2`-suffixed names then silently loses the
    // codec round-trip on the wire-shape side. Either keep this flag, or
    // leave the typescript plugin out entirely.
    { name: '@hey-api/typescript', includeInEntry: false },
    // `includeInEntry: true` (default is false on `@hey-api/client-fetch`)
    // surfaces the singleton `client` through the auto-barrel so the
    // consumer's `client.setConfig({ baseUrl })` line resolves from the
    // canonical entry. No name collision — `client.gen.ts` exports only
    // `client` and `CreateClientConfig`.
    { name: '@hey-api/client-fetch', includeInEntry: true },
    // `includeInEntry: false` is required: this plugin owns the public
    // SDK surface and emits a wrapper per operation under the canonical
    // name. Without it, `@hey-api/sdk`'s same-named raw functions would
    // collide with the wrappers in the auto-generated `index.ts`. The
    // plugin's pre-flight check throws with the exact config to write
    // if you forget.
    { name: '@hey-api/sdk', transformer: true, includeInEntry: false }
  ]
});
```

### Why `as never`

`registryPlugin` is `async` so it can dynamic-import `schemasFrom` for the
codegen-time audit. `defineConfig`'s plugin slot is typed as
`PluginNames | PluginConfig`, and that union doesn't accept the
`Promise<…>`-derived shape exposed here. The cast is safe — at the runtime
hey-api evaluates plugins, it has already been awaited. We could chase the
upstream type to remove the cast, but the surface is unstable enough that
pinning it would break on every minor hey-api bump. The cast is the
deliberately boring pin point. (`defineRegistryClientConfig` does this
cast internally.)

### Add `src/generated/` to `.gitattributes`

Once `src/generated/` is committed (recommended — see
[Codegen drift](#codegen-drift) below), keep GitHub from counting the
snapshot in language stats and from rendering the diff line-by-line in PRs:

```text
# .gitattributes
src/generated/** linguist-generated=true
```

### Output extension and import paths

`@hey-api/openapi-ts` emits `.js`-extension imports inside the generated
directory regardless of source language — those resolve correctly under
TypeScript's `module: "nodenext"` / `bundler` resolution and the Apps Team
template's `rewriteRelativeImportExtensions: true`. No `module.extension`
config required.

After `pnpm exec openapi-ts` runs, you'll find a generated
`registry-validator.gen.ts` alongside the rest of the client. Each operation's
response type is `z.output<typeof <Schema>>`, and each operation has a
matching `<opId>Transformer` function the SDK wires as the
`responseTransformer`.

## The `schemasFrom` option

`schemasFrom` is the option that delivers schema-first end-to-end. It is the
module specifier baked into the generated transformer file's `import`
statement for every Zod schema the plugin references:

```ts
// Generated registry-validator.gen.ts
import { Foo, Bar } from '@my-org/api-schemas';   // ← this `from` value is `schemasFrom`
```

The same string has to resolve at **two** points: at codegen time, when the
plugin's audit dynamic-imports it from the developer's machine, and at
runtime / bundle time, when the generated client imports schemas. So it must
be a specifier with a single unambiguous meaning regardless of who's
importing it.

### When schemas live in a separate package — use the package name

This is the canonical Apps Team setup: a dedicated schemas package
(e.g. `@my-org/api-schemas`) imported by both the service and the client
package. Just pass the package name:

```ts
schemasFrom: '@my-org/api-schemas'
// or, if schemas are exposed under a subpath export:
schemasFrom: '@my-org/api-schemas/zod'
```

Inside a monorepo, this works for both published consumers (npm resolves the
name) and workspace consumers (pnpm/yarn/npm linking handle it). For codegen,
make sure the schemas package's runtime entrypoint resolves before invoking
`openapi-ts` — typically by running `pnpm -r --if-present run build` first
(workspace topological order builds schemas before the client) or by using a
custom export condition like `@polygonlabs/source` to read source `.ts`
directly.

### When schemas live inside the client codegen package — self-link the package name

Sometimes a project doesn't justify a separate schemas package: the schemas,
the registry, and the client codegen all live together. Relative paths
won't work — they mean different things to the plugin's audit (resolved
from the plugin's install location) and the generated client (resolved from
the output dir). Give the package a real `name` + `exports` entry and
self-link it, then use the package's own name as `schemasFrom`:

```jsonc
// package.json
{
  "name": "@my-org/api-client",
  "exports": { ".": "./src/schemas/index.ts" },
  "devDependencies": {
    "@my-org/api-client": "link:."
  }
}
```

```ts
// openapi-ts.config.ts
schemasFrom: '@my-org/api-client'
```

The `link:.` entry materialises the package under its own
`node_modules/@my-org/api-client`, so the name resolves from **every**
import location: the plugin's codegen-time audit (which `import()`s
`schemasFrom` from the plugin's own install location, not from your
config file), the generated transformer under `./src/generated/`, and
your own source.

> **`package.json#imports` aliases (`'#schemas'`) do NOT work here** —
> an earlier revision of this README recommended one. Node resolves `#`
> aliases against the package containing the *importing module*, and the
> plugin's dynamic import runs from
> `node_modules/@polygonlabs/zod-to-openapi-heyapi/`, where your alias
> doesn't exist. The audit fails with
> `Package import specifier "#schemas" is not defined`. Use the
> self-linked package name above instead.

### What's not supported

- **Relative paths** (`'../schemas'`) — different meaning to the plugin and
  the generated client.
- **Default or namespace imports** — the plugin always emits
  `import { Name }`.
- **Renames** — the export's binding name must equal the registry name; see
  [Naming convention](#schemas-must-be-named-exports-and-the-export-name-must-match-the-registry-name)
  below.

### Resolution table

| Setup | `schemasFrom` |
|---|---|
| Schemas published to npm (root export) | `'@my-org/api-schemas'` |
| Schemas published as a subpath export | `'@my-org/api-schemas/zod'` |
| Schemas in the same monorepo (workspace package) | `'@my-org/api-schemas'` |
| Schemas in the same package as the codegen | The package's own name (self-linked via `"link:."`) |

### Schemas must be named exports, and the export name must match the registry name

The plugin discovers response schemas by walking the `OpenAPIRegistry` and
emits `import { <registeredName> } from '<schemasFrom>';` using the name you
passed to `register()`. That name has to be the same string as the schema's
exported binding — there is no rename layer:

```ts
// schemas/index.ts
export const Trade = z.object({ /* ... */ });
export const Trades = z.array(Trade);

// schemas/registry.ts
registry.register('Trade',  Trade);   // ✓ registry name === export name
registry.register('Trades', Trades);  // ✓
```

`registry.register('Trade', tradeSchema)` combined with
`export const tradeSchema = ...` will fail the
[codegen-time audit](#codegen-time-audit) — the plugin would emit
`import { Trade } from '...'` and that wouldn't resolve. Default or namespace
exports don't work either; the generated code is always
`import { name }`.

### The schemas package is a real runtime dependency

This trips people up: the schemas package isn't a build-time artifact, it's
runtime code. The generated transformer calls `Schema.parseAsync(data)` on
every response — that call runs in the consumer's process, against the
imported `Schema` value, every time a response comes back.

What that means for the consumer:

- **Bundled clients** (Vite, webpack, esbuild, etc.) — the bundler resolves
  `schemasFrom` at bundle time and inlines the schemas into the output. The
  deployed bundle is self-contained, so `node_modules` doesn't need to ride
  along to production. But the schemas are still *executing* at runtime;
  they're just embedded in the bundle rather than resolved from disk.
- **Unbundled Node consumers** (server-side code, CLI tools, etc.) — the
  schemas package must be installed in `node_modules` for every cold boot.
  Declare it under `dependencies`, not `devDependencies`.

If you're bringing the schemas in from another package — typical setup,
since that's the whole point of this plugin — make sure that package is in
your client's runtime dependency list, not just a build/dev dep.

The mechanism is deliberately boring: same module specifier, same Zod
schemas, same validation on both sides of the wire.

## Codegen-time audit

The `schemasFrom` ↔ registered-name agreement is enforced at codegen. The
plugin dynamic-imports `schemasFrom` and, for **every schema referenced as a
`$ref` from a route response** and **every registered request-slot schema**,
verifies:

1. The module has a named export with that exact name.
2. The export is a Zod schema (duck-typed: has `_def` or a `parseAsync`
   method).

This is a pure string-membership check over export names — no schema
instances are compared — so it holds even when codegen runs under a
module-evaluation split (see
[How input schema names are resolved](#how-input-schema-names-are-resolved)).

Mismatches fail the codegen step with an aggregated error listing every
issue at once, so a typo or forgotten export surfaces immediately on the
developer's machine instead of as a confusing import error in a downstream
consumer's build.

```text
[zod-to-openapi-heyapi] codegen-time audit found 2 issues:
  - 'Customer' is referenced as a response schema but is not a named export
    of '@my-org/my-schemas'. The plugin emits `import { Customer } from
    '@my-org/my-schemas'`, which will fail at consumer build time. Either
    export Customer from that module under that exact name, or unregister it.
  - 'Order' is exported from '@my-org/my-schemas' but does not appear to be
    a Zod schema (got string). The plugin emits `Order.parseAsync(data)`,
    which will fail at consumer runtime.
```

### What the audit ignores

The audit walks **only** names the generated client will actually import:
response `$ref` targets and registered request-slot schemas. Schemas
registered for other purposes never reach the generated client and don't
need a matching Zod export:

- Path / query / header parameters registered via `registry.registerParameter(...)`.
  zod-to-openapi v8's `OpenApiGeneratorV3` lifts parameter schemas into
  `components.schemas` as well as `components.parameters` — the audit
  ignores them because the plugin doesn't emit any import for them.
- Anonymous inline request schemas (codec-free; codec-bearing ones fail
  codegen before the audit even runs — see
  [How input schema names are resolved](#how-input-schema-names-are-resolved)).
- Internal building blocks composed into other schemas (e.g. an
  `AddressSchema` factored out of a larger object) — they only need the
  outer registered schema's export.

### Resolution failures (`ERR_MODULE_NOT_FOUND`)

If the dynamic import itself fails the plugin throws a different error
mentioning the most common causes:

- The schemas package isn't installed in the consumer's `node_modules`.
- The package is installed but resolves to a `dist/` that hasn't been built
  yet — common in monorepos using a custom export condition for build-free
  dev (e.g. `@polygonlabs/source`). Either run
  `node --conditions=<your-condition> ./node_modules/.bin/openapi-ts` or
  build the schemas package before regenerating the client.
- A relative path was passed for `schemasFrom`. Use a package specifier or a
  `#imports` alias instead.

## Caveat: `.openapi()` cannot be chained onto imported codecs

Zod v4 wires methods onto subclass prototypes at construction time rather
than relying on the prototype chain. A codec defined inside another
package (e.g. `@polygonlabs/zod-codecs`'s `Int64Codec`) was constructed
**before** `extendZodWithOpenApi(z)` ran in your schemas file — the
prototype patch never reaches it, and chaining `.openapi(...)` directly on
the imported codec throws at module load:

```ts
import { Int64Codec } from '@polygonlabs/zod-codecs';

// ✗ TypeError: Int64Codec.openapi is not a function
const BlockNumber = Int64Codec.openapi({ description: 'Block number' });
```

Use the codec as-is and put per-field metadata on the surrounding object's
`.openapi()` call:

```ts
extendZodWithOpenApi(z);

// ✓ Works — z.object() is constructed after the patch and has .openapi()
export const BlockNumberResponse = z
  .object({
    blockNumber: Int64Codec   // codec used inline, no chained .openapi(...)
  })
  .openapi('BlockNumberResponse', {
    description: 'Latest block number from the configured RPC endpoint'
  });
```

Codecs you define inline in the same file as `extendZodWithOpenApi(z)` can
chain `.openapi(...)` because the construction happens after the patch.
Only **imported** codecs hit this constraint.

## Generated client uses fetch globals

`@hey-api/openapi-ts`'s vendored fetch client references `BodyInit`,
`HeadersInit`, `RequestInit`, and `ResponseInit` — DOM globals. If your
consumer's tsconfig doesn't include the DOM lib (typical for Node
services that didn't previously consume browser APIs), typecheck fails
with `Cannot find name 'BodyInit'`.

Two ways to fix it. Pick one:

**Option A — add DOM lib to the consumer's tsconfig.** Simplest; one line:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "lib": ["es2024", "DOM", "DOM.Iterable"]
  }
}
```

The DOM types are type-only — no runtime impact — but they pollute global
scope with browser identifiers (`Window`, `Document`, `localStorage`, …).
For most services that's harmless; if you'd rather keep DOM out, use
Option B.

**Option B — declare the fetch types globally from `undici-types`.** Drop
this file anywhere your tsconfig's `include` covers (e.g.
`src/types/fetch-globals.d.ts`):

```ts
import type * as undici from 'undici-types';

declare global {
  type BodyInit = undici.BodyInit;
  type HeadersInit = undici.HeadersInit;
  type RequestInit = undici.RequestInit;
  type ResponseInit = undici.ResponseInit;
}

export {};
```

`undici-types` ships transitively with `@types/node` ≥ 18, so no extra
install needed. The declarations are type-only; no runtime cost.

This is upstream's choice — the plugin itself doesn't emit any DOM
references — so the workaround sits in the consumer.

## Don't install `@hey-api/client-fetch` separately

The deprecation message on
[npm/@hey-api/client-fetch](https://www.npmjs.com/package/@hey-api/client-fetch)
("Starting with v0.73.0, this package is bundled directly inside
@hey-api/openapi-ts") is informational, not a request to install another
package. Starting from `@hey-api/openapi-ts@0.73`, the fetch client's source
is **vendored** into the generated output directory (`src/generated/client/`,
`src/generated/core/`) — there is no separate runtime dependency to install.

If your `package.json` lists `@hey-api/client-fetch` under `dependencies` or
`devDependencies`, drop it. The deprecation warning during `pnpm install`
goes away, and the generated client keeps working — its imports are
relative paths into the vendored directory.

## `defineRegistryClientConfig` options

| Option | Type | Description |
|---|---|---|
| `registry` | `OpenAPIRegistry` | The same registry used to generate the OpenAPI spec. The plugin runs the same generator internally to discover schema names — no hardcoded list. |
| `schemasFrom` | `string` | Module specifier the generated client imports your schemas from. Must be unambiguous from any caller (package name, `#imports` alias, or `file://` URL — not a relative path). See [The `schemasFrom` option](#the-schemasfrom-option). |
| `input` | `UserConfig['input']` | OpenAPI spec input — passed through to `createClient`. URL string, filesystem path, or parsed spec object. |
| `output` | `UserConfig['output']` | Output directory configuration — passed through to `createClient`. Path string or full output object. |
| `tanstackReactQuery` | `boolean` | When `true`, wires the upstream `@tanstack/react-query` plugin into the config and installs a parser-level `isQuery` hook so this plugin and upstream split factory emission cleanly (codec ops here, everything else upstream). See [TanStack Query factories](#tanstack-query-factories) below. Defaults to `false`. `@tanstack/react-query` is an optional peer dependency. |
| `parser` | `UserConfig['parser']` | Optional pass-through for the openapi-ts `parser` config (filters, transforms, custom hooks). The factory's own `isQuery` hook composes with whatever you provide here — yours runs after ours. |

## Advanced — `registryPlugin` options

These describe the lower-level `registryPlugin` export. Use the factory
above unless you have a reason to compose the plugin list yourself.

| Option | Type | Description |
|---|---|---|
| `registry` | `OpenAPIRegistry` | The same registry used to generate the OpenAPI spec. The plugin runs the same generator internally to discover schema names — no hardcoded list. |
| `schemasFrom` | `string` | Module specifier the generated client imports your schemas from. Must be unambiguous from any caller (package name, `#imports` alias, or `file://` URL — not a relative path). See [The `schemasFrom` option](#the-schemasfrom-option). |
| `generatorClass` | `OpenApiGeneratorV3` | Pass `OpenApiGeneratorV3` from `@asteasolutions/zod-to-openapi` explicitly. Avoids resolution ambiguity in the codegen environment. |
| `$` | `typeof $` | Pass `$` from `@hey-api/openapi-ts` explicitly. Same reason. |
| `tanstackReactQuery` | `boolean` | Emit codec-aware TanStack Query factories for **codec ops only** (operations with a registered input schema). Non-codec ops are deliberately skipped — pair with the upstream `@tanstack/react-query` plugin and a parser-level `isQuery: false` hook for those op ids to avoid name collisions. `defineRegistryClientConfig` automates that wiring. Defaults to `false`. Adds a runtime peer-dep on `@tanstack/react-query` for consumers who use it. |

## SDK wrappers

The plugin emits one canonical SDK function per operation in
`registry-validator.gen.ts`. With `includeInEntry: false` on
`@hey-api/sdk` (required, see Usage), these wrappers are the only public
SDK surface: the auto-generated `index.ts` re-exports them under the
operation's plain name (`getBlockMetadata`, `createMessage`, …). The raw
SDK functions in `sdk.gen.ts` are an implementation detail — the wrapper
delegates to them for HTTP wiring.

The wrapper has four flavours, picked by what the op declares:

| Op declares | Wrapper |
|---|---|
| Nothing (no input schema, no error schema) | Pass-through arrow |
| Input schema only | Input-encoding wrapper |
| Error schema only | Error-decoding wrapper |
| Both | Combined wrapper (encode in, decode out) |

The pass-through case is the bottom rung — same call signature as the
upstream SDK function, the wrapper just forwards `options`. We emit it
as a typed arrow rather than a `const X = X2` re-bind so
`wrapperFn.name === '${opId}'` for telemetry / logging that
introspects the canonical operation name (a re-bind would keep
hey-api's auto-aliased `${opId}2` as the function's `.name`):

```ts
// Generated registry-validator.gen.ts
export const getBlockNumber = async <ThrowOnError extends boolean = false>(
  options?: Options<GetBlockNumberData, ThrowOnError>
) => await getBlockNumber2(options);
```

For ops whose `request.{params, query, body}` schema is registered
(`.openapi('Name')` chained, or the value returned by
`register('Name', schema)`) and exported from `schemasFrom` under the
registered name, the wrapper additionally encodes the runtime → wire
direction before delegating:

```ts
// Generated registry-validator.gen.ts
export type GetBlockMetadataInput = Omit<GetBlockMetadataData, 'path'> & {
  // Runtime shape (`bigint`), not the wire string `BlockMetadataData.path` declares.
  path: z.output<typeof BlockNumberPathParams>;
};

export const getBlockMetadataInputTransformer = async (
  input: Pick<GetBlockMetadataInput, 'path'>
) => ({ path: await z.encode(BlockNumberPathParams, input.path) });

export const getBlockMetadata = async <ThrowOnError extends boolean = false>(
  options: Options<GetBlockMetadataInput, ThrowOnError>
) => {
  const transformed = await getBlockMetadataInputTransformer(options);
  return await getBlockMetadata2({ ...options, ...transformed });
};
```

`z.encode(schema, value)` runs the runtime → wire direction of any Zod
schema, including codecs:
`Int64Codec.encode = (b) => b.toString()`,
`IsoDateCodec.encode = (d) => d.toISOString()`. The case this matters
for is `IsoDateCodec` on a path or query parameter: `String(date)`
emits the locale string and the server's `z.iso.datetime()` validator
rejects it, but `z.encode` produces the ISO 8601 string the parser
accepts. Number-flavoured codecs (`Int64Codec`, `BigIntegerCodec`,
`DecimalStringCodec`) get the same ergonomic typing on the request side
as on the response side.

### How input schema names are resolved

The plugin reads the slot name from **registration metadata**: the
refId that `.openapi('Name')` or `register('Name', schema)` attached
to the schema instance the route holds. The registered name becomes
the import binding, exactly as it does for response schemas — and the
same [codegen-time audit](#codegen-time-audit) verifies a Zod-shaped
named export exists under that name in `schemasFrom`.

Because the refId travels with the instances the registry itself hands
the plugin, resolution never depends on comparing instances against a
separately imported copy of the schemas module. That makes it immune
to module-evaluation splits: openapi-ts loads the codegen config
through c12/jiti, and under a custom export condition (e.g.
`NODE_OPTIONS='--conditions=@polygonlabs/source'` for build-free
codegen) the schemas package's `.ts` source can be evaluated twice —
once in the config loader's cache, once natively. Names are identical
across evaluations; instances are not. (An earlier instance-identity
lookup silently dropped every codec input transformer under exactly
that split.)

An unregistered slot is silently skipped only when it is codec-free
(the anonymous-inline-schema case, `params: z.object({ id: z.uuid() })`
written directly in the route). A codec-bearing slot that is not
registered **fails the codegen**, listing the offending operation/slot
pairs and the remedy — skipping it would emit a client that types the
slot wire-shaped and never runs `z.encode`, sending wire-invalid
values (a `Date` as a locale string) while compiling clean.

The user-side rule: **register the schema, export it under the
registered name, and use that registered instance in the route**.

```ts
// schemas.ts — registered, export name === registered name
export const BlockNumberPathParams = z
  .object({ blockNumber: Int64Codec })
  .openapi('BlockNumberPathParams');

// routes/blocks.ts — the registered export in request.params
import { BlockNumberPathParams } from '../schemas.ts';
registry.registerPath({
  operationId: 'getBlockMetadata',
  method: 'get',
  path: '/api/blocks/{blockNumber}',
  request: { params: BlockNumberPathParams },
  // ...
});
```

One sharp edge: `.openapi('Name')` and `register('Name', schema)`
both *clone* the schema (asteasolutions creates a new instance via
`new this.constructor(this._def)` so chained metadata calls don't
accumulate), and the registration metadata lives on the **returned**
instance. The route must hold that returned value — chaining
`.openapi(...)` at the export site (as above) makes this automatic. A
route that holds the pre-`.openapi` / pre-`register` original carries
no refId and behaves like an unregistered slot.

### Per-slot optionality

The plugin mirrors hey-api's `${Op}Data` slot optionality in the
emitted `${Op}Input` and the wrapper's `options` parameter. A route
whose query schema has only optional fields (no required query
params) emits:

```ts
export type ListMessagesInput = Omit<ListMessagesData, 'query'> & {
  query?: z.output<typeof RecentMessagesQuery>;
};

export const listMessages = async <ThrowOnError extends boolean = false>(
  options?: Options<ListMessagesInput, ThrowOnError>
) => { ... };
```

— so callers can write `listMessages()` with no args. Routes with a
required path slot emit `path: ...` and `(options: ...)` (no `?`),
demanding the slot at the call site. The detection mirrors hey-api's
own `hasParameterGroupObjectRequired` for params / query / headers and
reads `body.required` for the body slot — set
`body: { required: true, ... }` on the route config if the body should
be required (asteasolutions defaults to optional otherwise).

### Error response decoding

Operations that declare error response schemas get an
`${opId}ErrorTransformer` (mirrors the success-side `${opId}Transformer`
shape — `parseAsync` against a single schema or `z.union(...)` for
multi-status). The SDK wrapper calls it on both throwOnError paths so
the runtime value matches the codec runtime types declared in
`${Op}Error`. Two boundaries the wrapper crosses:

1. **Did the request reach the API at all?** No → `TransportError`.
   Yes → next.
2. **Does the response body match a registered error schema?** Yes →
   typed `${Op}Error`. No → `ResponseValidationError`.

Both `TransportError` and `ResponseValidationError` are emitted as classes
alongside the SDK wrappers — see [The wrapper-emitted error
classes](#the-wrapper-emitted-error-classes) below.

#### `throwOnError: false`

```ts
import { isTransportError, isResponseValidationError } from './generated/registry-validator.gen.js';

const { data, error } = await getX();
if (isTransportError(error)) {
  // Request never produced an HTTP response. error.cause is the
  // native fetch error (TypeError / AbortError / Node SystemError
  // carrying ECONNRESET / ETIMEDOUT / etc.).
  log.error('network', error.cause);
} else if (isResponseValidationError(error)) {
  // The server replied, but the body didn't match any registered
  // error schema. error.cause is the ZodError carrying parse
  // issues; error.body is the original wire body (one hop, same
  // depth as transport's .cause).
  log.error('schema mismatch', { issues: error.cause.issues, body: error.body });
} else if (error) {
  // Typed ${Op}Error — error.code, error.traceId etc. all type-checked.
  if (error.code === 'not_found') ...
}
```

`result.error`'s static type widens to
`${Op}Error | TransportError | ResponseValidationError | undefined`, so the
three branches above are exhaustive — TS errors if a consumer reads
`error.<typed-field>` without narrowing first. The widening is
delivered by an emitted file-scope `WrapErrors<TData, TError,
ThrowOnError>` type alias that wraps each per-op return; the two
`is*Error` helpers are emitted as type predicates
(`value is TransportError`), so each `if` block narrows `error`
correctly without further casts.

#### `throwOnError: true`

The wrapper throws one of the same three shapes. Consumer's `catch`
narrows the same way:

```ts
try { await getX({ throwOnError: true }); }
catch (err) {
  if (isTransportError(err)) { /* … */ }
  else if (isResponseValidationError(err)) { /* … */ }
  // else: typed ${Op}Error
}
```

A union helper `isWrapperError(value): value is TransportError |
ResponseValidationError` is also emitted, for "log any wrapper-emitted error
generically" call sites that don't care which category — saves
writing `isTransportError(x) || isResponseValidationError(x)`.

#### Why a wrapper at all

`@hey-api/client-fetch` only invokes the `responseTransformer` on
2xx bodies — error responses bypass it. Without the wrapper, the
`${Op}Error` types would claim codec runtime shapes (`bigint`,
`Date`) while the consumer received wire-shape values. The
TransportError / ResponseValidationError split is what keeps `${Op}Error` narrow
and honest: when `result.error` is the typed shape, it really is
the codec runtime shape; non-conforming responses end up in their
own typed slot.

### The wrapper-emitted error classes

```ts
/** @internal — codegen-emitted; consumers narrow via isTransportError. */
class TransportError extends Error {
  readonly cause: Error;
  // super message: 'Request failed before producing an HTTP response'
  // Carries a symbol-keyed marker:
  //   this[Symbol.for('@polygonlabs/zod-to-openapi-heyapi/is-transport-error')] = true
}

/** @internal — codegen-emitted; consumers narrow via isResponseValidationError. */
class ResponseValidationError extends Error {
  readonly cause: ZodError;        // parseAsync's issues
  readonly body: unknown;          // original wire body (one hop, no walking)
  // super message: 'API response did not match the registered schema'
  // Carries a symbol-keyed marker:
  //   this[Symbol.for('@polygonlabs/zod-to-openapi-heyapi/is-response-validation-error')] = true
}

// Type-predicate guards — the only consumer-facing narrowing API.
declare const isTransportError: (value: unknown) => value is TransportError;
declare const isResponseValidationError:   (value: unknown) => value is ResponseValidationError;
declare const isWrapperError:   (value: unknown) => value is TransportError | ResponseValidationError;
```

Both extend `Error` so they integrate with `try/catch`, structured
logging (Sentry / pino walk `.cause`), and any tooling that
introspects error chains. Both are tagged `@internal` — the wrapper
constructs them; consumer-thrown instances would erode the
discriminator's meaning.

The two classes split by **whether the request reached the API**.
That boundary is categorically different from "did the response
match our schema":

- **TransportError** is for `ECONNRESET` / `ENOTFOUND` /
  `ETIMEDOUT` / abort / DNS / TLS handshake failures — the request
  never got an HTTP response back. Retry policies, alerting, and
  service-level monitoring usually want this category isolated.
- **ResponseValidationError** is for "got bytes, can't decode" — schema
  drift, foreign errors from a CDN or gateway, or simply a
  registered schema that's out of date. The handling here is
  typically "log the body, file a bug, return a generic 'something
  went wrong' to the user."

Wrapping `TransportError` (rather than letting native `TypeError` /
`AbortError` bubble through unchanged) gives consumers a uniform
narrowing API. The marker is a `Symbol.for(...)` value, not a
string `_tag` field, so it survives cross-realm boundaries
(workers, iframes, multiple bundle copies) where `instanceof` loses
identity — `Symbol.for` returns the same symbol globally regardless
of which copy of the module is loaded. Two separately-generated
clients in the same process produce mutually-narrowable
`TransportError` instances by design; the marker key is intentionally
shared across all consumers of the plugin.

#### Detecting transport errors

The wrapper discriminates transport rejections from HTTP error bodies
via `err instanceof Error`. Fetch's transport errors (`TypeError`,
`AbortError`, Node `SystemError`) all extend the global `Error`
constructor in the same realm as the wrapper's call site; hey-api's
wire-shape error bodies are plain object literals, never Error
instances. (An earlier `'stack' in err` duck-type heuristic was
rejected: debug-mode servers — Express / Koa / FastAPI — include
stack traces in error JSON, which would mis-classify a real HTTP
error body as TransportError and skip `parseAsync` entirely.)

Pass-through ops — those with no input schemas AND no error schemas —
stay re-binds (`export const ${opId} = ${opId}2`) so the auto-barrel
still exposes a single canonical name with zero overhead. Ops with
errors but no input get a real wrapper; ops with input but no errors
get the existing input-encoding wrapper; ops with both get both
pipelines composed in one wrapper body.

#### Consumer narrowing — the canonical pattern

The codegen-emitted `isTransportError` / `isResponseValidationError` /
`isWrapperError` guards plus the wrapper's widened return type ARE
the consumer narrowing API. The wrapper's return is statically
`${Op}Error | TransportError | ResponseValidationError | undefined`; once you
peel off the wrapper-error branches via the predicates, the
remaining static type is the typed `${Op}Error` — no `as` casts, no
type hints, no manual narrowing:

```ts
import {
  getX,
  isTransportError,
  isResponseValidationError
} from '@my-org/api-client';

const { data, error } = await getX();
if (isTransportError(error))      log.network(error.cause);
else if (isResponseValidationError(error))   log.schemaDrift({ issues: error.cause.issues, body: error.body });
else if (error)                   handleTyped(error);   // typed ${Op}Error, full field access
```

The consumer's `@my-org/api-client` package re-exports the
codegen-emitted guards as part of its public surface. **Don't import
from `./generated/*.gen.js` directly** — those are codegen artifacts
that may move or rename. The published package is the contract.

#### Cross-client runtime helpers

For code paths that work across multiple generated clients (logging
adapters, error-reporting middleware) there's a small structural
surface published at `@polygonlabs/zod-to-openapi-heyapi/errors`.
Useful when you don't have the wrapper return type in scope:

```ts
import {
  categorizeApiError,
  getApiErrorMessage,
  isTransportError,
  isResponseValidationError,
  isWrapperError,
  TRANSPORT_ERROR_MARKER,
  RESPONSE_VALIDATION_ERROR_MARKER,
  type TransportError,
  type ResponseValidationError,
  type ErrorCategory
} from '@polygonlabs/zod-to-openapi-heyapi/errors';

const category = categorizeApiError(error);
switch (category.kind) {
  case 'transport':           /* category.error: TransportError          */ break;
  case 'response-validation': /* category.error: ResponseValidationError */ break;
  case 'native-error':        /* category.error: Error                   */ break;
  case 'other':               /* category.error: unknown                 */ break;
}
```

Same symbol-keyed marker the codegen-emitted guards check (the
markers come from the global `Symbol.for(...)` registry, so they're
identity-stable across realms / module copies / iframes / workers).
Two separately-generated clients in the same process produce
mutually-narrowable instances.

The runtime helper deliberately **does not** invent a typed-error
category. The wrapper return already encodes the typed `${Op}Error`
union statically; a runtime helper inventing a magic-string
convention (e.g., `{ code: string; message: string }`) for a
"typed" branch would lose the per-op typing the wrapper return
carries. Code paths without the wrapper return in scope land typed
errors in the `other` bucket; consumers with the typed return in
scope should narrow with the codegen-emitted predicates directly.

`getApiErrorMessage(error, fallback?)` returns `error.message` for
`Error` instances (including wrapper-emitted ones, which extend
`Error`) and the supplied fallback otherwise. It does NOT special-
case typed-error shapes — same reason as above.

### What's not covered

- **Headers**: schema-typed header maps are out of scope. Headers are
  rarely codec-typed in practice; if they become a need, the plugin
  recognises a registered headers ZodObject the same way it recognises
  params / query, but the emit needs verification against
  `@hey-api/client-fetch`'s header-serialisation surface.

## `responseStyle` is threaded through wrapper return types

Hey-api supports two response styles, set on the client config or
per-call options:

- `responseStyle: 'fields'` (default) — wrapper returns the
  discriminated envelope `{ data, error, request, response }` (no-
  throw) or `{ data, request, response }` (throw, error path
  thrown).
- `responseStyle: 'data'` — wrapper returns the flat payload
  (`TData` for throw, `TData | undefined` for no-throw — hey-api's
  runtime swallows errors as `undefined` in `'data'` + no-throw).

The plugin's wrappers thread `TResponseStyle` as a fourth generic
through `WrapErrors` (error-widening wrappers) and
`WrapPassThrough` (pass-through wrappers). Pinning the generic at
the call site narrows the static return to match whichever style
the runtime selects:

```ts
import { client, getX } from '@my-org/api-client';

client.setConfig({ responseStyle: 'data' });

// Static return: `Promise<XData>` — flat, no envelope.
const data = await getX<true, 'data'>();

// Static return: `Promise<XData | undefined>` — flat or undefined.
const maybe = await getX<false, 'data'>();

// Default 'fields' shape — static return is the discriminated envelope.
const result = await getX();
```

Runtime behaviour stays in step: the wrapper's error-wrapping logic
gates on `'request' in result && 'response' in result` (hey-api
always emits those two keys in 'fields' mode and never in 'data'
mode), and the try/catch around the SDK call wraps thrown errors in
either style. Consumers using `'data'` + `throwOnError: true` catch
wrapper-emitted `TransportError` / `ResponseValidationError` in
their `catch` block, narrowing with the codegen-emitted `is*Error`
predicates.

## What gets emitted

For every operation whose response is a `$ref` to a registered schema, the
plugin emits a block like:

```ts
import { z } from 'zod';
import { Foo } from '@my-org/my-schemas';

export type GetFooResponses = {
  200: z.output<typeof Foo>;
};

export type GetFooResponse = GetFooResponses[keyof GetFooResponses];

export const getFooTransformer = async (data: unknown): Promise<z.output<typeof Foo>> =>
  await Foo.parseAsync(data);
```

`Responses` is keyed by status code so it composes cleanly with operations
that declare more than one response (see
[Multi-status responses](#multi-status-responses)). `Response` is
`Responses[keyof Responses]` — the union of bodies across every declared
status.

The SDK plugin (`@hey-api/sdk` with `transformer: true`) wires
`responseTransformer: getFooTransformer` onto the route's call options, so
the fetch client runs the transformer on the raw JSON response and the
codec decode reaches the caller.

## Multi-status responses

The plugin handles operations that declare more than one response status. For
each operation it walks the full responses map and splits 2xx (success) from
non-2xx (errors), emitting two pairs of types:

```ts
// 200 + 201 success, 400 + 404 + 500 errors
export type CreateOrFetchResourceResponses = {
  200: z.output<typeof ResourceFetched>;
  201: z.output<typeof ResourceCreated>;
};
export type CreateOrFetchResourceResponse =
  CreateOrFetchResourceResponses[keyof CreateOrFetchResourceResponses];

export type CreateOrFetchResourceErrors = {
  400: z.output<typeof BadRequestError>;
  404: z.output<typeof NotFoundError>;
  500: z.output<typeof ServerError>;
};
export type CreateOrFetchResourceError =
  CreateOrFetchResourceErrors[keyof CreateOrFetchResourceErrors];
```

`@hey-api/sdk` reads the `Errors` symbol when typing the second generic of
`client.method<Responses, Errors, ThrowOnError>(...)`, so a caller that passes
`throwOnError: false` gets a fully-typed `error` field on the result.

### The runtime transformer

The fetch client invokes the response transformer for any 2xx status,
without passing the status code. When an operation has multiple distinct 2xx
schemas the plugin emits a `z.union(...)` transformer so the parser accepts
any of them:

```ts
// One 2xx schema → simple form
export const getFooTransformer = async (data: unknown): Promise<z.output<typeof Foo>> =>
  await Foo.parseAsync(data);

// Multiple distinct 2xx schemas → union form
export const createOrFetchResourceTransformer = async (
  data: unknown
): Promise<z.output<typeof ResourceFetched> | z.output<typeof ResourceCreated>> =>
  await z.union([ResourceFetched, ResourceCreated]).parseAsync(data);
```

Operations whose only responses are errors get the `Errors`/`Error` types
but no success transformer (there's no 2xx body to decode). They still get
an `${opId}ErrorTransformer` and a wrapper that runs it on the error
path — see [Error response decoding](#error-response-decoding) above.

## TanStack Query factories

Set `tanstackReactQuery: true` on `defineRegistryClientConfig` to wire
in the upstream `@tanstack/react-query` plugin AND emit codec-aware
factories from this plugin. The factory installs everything; the only
thing you change is the flag.

```ts
const blockMetadata = useQuery(
  getBlockMetadataOptions({ path: { blockNumber: 23000000n } })
);
```

The factory's `options` parameter for codec ops is typed against
`${Op}Input` — codec runtime shapes (`bigint`, `Date`, …), exactly as
callers pass them at the SDK call site. The queryKey carries
**wire-shape** values for codec slots: the factory runs
`z.encode(Schema, options.<slot>)` synchronously when building the
key, so the default `JSON.stringify`-based `queryKeyHashFn` stays
hash-stable without consumers having to configure a bigint-aware hasher
on their `QueryClient`. Two distinct `bigint` block heights produce two
distinct hash-stable keys; cache identity is preserved via the encoded
string.

The queryFn calls the **raw** SDK function from `sdk.gen.ts`, not the
SDK wrapper — the wrapper would re-encode the already-wire-shaped slots
in `queryKey[0]` and produce nonsense. The wire-shape values reach the
fetch client directly.

The error generic on `queryOptions<...>` is the operation's `${Op}Error`
union when the route declared error responses, falling back to
`@tanstack/react-query`'s `DefaultError` otherwise. So a caller reading
`result.error` against a route with typed errors gets the right body
shape, not `unknown`.

### How the composition works

Codec ops (operations whose `request.{params, query, body, headers}` is
a registered Zod schema) get factories from **this plugin**, in the
same `registry-validator.gen.ts` file as the SDK wrappers. Non-codec
ops get factories from the **upstream** `@tanstack/react-query` plugin,
in its own dedicated file. Both halves use the same names
(`${opId}Options` / `${opId}QueryKey`), so the consumer call site sees
one naming scheme.

The split is enforced at the parser level via a
`parser.hooks.operations.isQuery` hook the factory installs: codec op
ids return `false` there, and the upstream plugin skips them. Without
this gating both plugins would emit factories under the same names and
collide in the entry barrel.

Operations without a 2xx response (errors-only ops) and operations
without registered input schemas neither produce a codec factory from
this plugin (no codec runtime shape to type against, or no Response
type to parameterise) — those go through the upstream plugin
unchanged.

### Both factory files reach the canonical `index.ts`

`defineRegistryClientConfig` sets `includeInEntry: true` on the
upstream `@tanstack/react-query` plugin (and filters out its
colliding `QueryKey` type-alias emission via a predicate, since this
plugin emits the canonical `QueryKey<TOptions>`). The codec-aware
factories live in `registry-validator.gen.ts`; the upstream
factories live in `@tanstack/react-query.gen.ts`; both flow through
the auto-barrel under the same op-id naming. So a consumer's React
re-export looks like:

```ts
// my-api-client/src/react.ts — no `.gen.js` paths
export {
  getBlockMetadataOptions, // codec-aware (registry-validator.gen.ts)
  getMessageOptions, // upstream (@tanstack/react-query.gen.ts)
  // …
} from './generated/index.js';
```

The split-by-codec-status is an internal codegen concern; the
canonical entry hides it.

## Codegen drift

The recommended pattern is to **commit the generated `src/generated/`
directory** and gate it with a `codegen-drift-check` script in the package's
scripts:

```jsonc
// package.json
{
  "scripts": {
    "generate": "openapi-ts -f openapi-ts.config.ts",
    "codegen-drift-check": "pnpm run generate && git diff --exit-code -- src/generated"
  }
}
```

CI runs `codegen-drift-check`, so any spec change without a regenerated
client surfaces as a PR review item. Adopters get this for free with no
extra workflow plumbing — wire it into the same job that runs lint /
typecheck.

## Sonar / static-analysis tools

If your repo runs SonarCloud (or any static-analysis tool with similar
behaviour), exclude `src/generated/**` from analysis. Without exclusions
the generated code dominates issue counts and blocks the quality gate
without anything actionable to fix:

```properties
# sonar-project.properties
sonar.exclusions=**/src/generated/**
sonar.coverage.exclusions=**/src/generated/**
```

(See the `sonar-project.properties` in the
[apps-team-ts-template](https://github.com/0xPolygon/apps-team-ts-template)
for the canonical version.)

## Migration

### From `*Schema`-suffixed exports

A common pre-existing pattern in the team's code is
`export const FooSchema = z.object(...).openapi('Foo'); export type Foo = z.infer<typeof FooSchema>;`.
The plugin requires the schema export's binding name to equal the registry
name, so adopting it means renaming the export to drop the suffix. The type
alias `Foo` then collides with the renamed schema export.

Recommended migration steps:

1. **For schemas registered as OpenAPI components** (those with
   `.openapi('Name')` chained), drop the `Schema` suffix on the export and
   match the registered name verbatim:

   ```ts
   // before
   export const FooSchema = z.object({ ... }).openapi('Foo');
   export type Foo = z.infer<typeof FooSchema>;

   // after
   export const Foo = z.object({ ... }).openapi('Foo');
   // Drop the type alias — see step 3.
   ```

2. **Unregistered building blocks can keep the `Schema` suffix.** The
   plugin's audit ignores them, and keeping the suffix distinguishes "this
   is a Zod schema, not a registered component" at call sites. Registered
   request-slot schemas (params / query / body used in routes) follow
   step 1 — their export name must match the registered name.

3. **Replace the type alias with `z.output<typeof Schema>` (or `z.infer`)
   inline at the call site:**

   ```ts
   // before
   function handle(body: Foo) { ... }

   // after
   function handle(body: z.infer<typeof Foo>) { ... }
   ```

   `z.output` is what the plugin's generated transformer uses — it covers
   codecs (the runtime type, not the wire string). `z.infer` is fine when no
   codec is involved.

4. **Update callers** in the same PR. The audit will fail loudly if any
   registered name still has a `*Schema`-suffixed export, so a half-done
   migration produces a clear error rather than silent runtime breakage.

### From orval, openapi-typescript, or `@hey-api/zod`

These tools all derive types from the OpenAPI spec rather than importing
the source Zod schemas. They lose codecs, refinements, branded types, and
custom error messages — adoptions are net upgrades in correctness, not
just ergonomics.

Practical steps:

- Replace the orval / openapi-typescript invocation with
  `@hey-api/openapi-ts` + this plugin. See [Usage](#usage).
- Migrate any custom `customFetch`-style fetch adapter to the singleton
  `client.setConfig({ fetch: ... })` pattern, or — for SSR / multi-instance
  setups — to `createClient(createConfig({ fetch: ... }))`.
- Wherever a caller formerly read `result.data.something` from the orval
  shape (`{ data, status, headers }`), the hey-api shape is
  `{ data, error, ... }`; `result.data` becomes the parsed body directly.
- Drop any inline Zod re-derivations (typically `z.infer<typeof
  components['schemas']['Foo']>` or similar). Import the actual schema
  instead.

## Testing consumer code

The generated client works with MSW-style HTTP fakes — point the client at a
mock baseUrl, register handlers for the routes under test, and call the SDK
function. The transformer runs on the response body, so codec decode is
exercised end-to-end:

```ts
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { client } from './generated/client.gen.ts';
import { getPayment } from './generated/sdk.gen.ts';

const server = setupServer();
beforeAll(() => {
  client.setConfig({ baseUrl: 'http://api.test' });
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

it('decodes int64 wire strings to bigint', async () => {
  server.use(
    http.get('http://api.test/payments/:id', () =>
      HttpResponse.json({ id: 'p_1', amount: '999999999999' })
    )
  );
  const { data } = await getPayment({ path: { id: 'p_1' } });
  expect(typeof data!.amount).toBe('bigint');
  expect(data!.amount).toBe(999999999999n);
});
```

`test/api.test.ts` in this package follows the same pattern against the
fixture registry — see it for multi-status, error-path, and parse-rejection
examples.

## Constraints — what the plugin doesn't handle

- **Inline response schemas** (no `$ref` to a registered schema) are skipped
  — there's no Zod schema to bind to. To get a transformer, register the
  schema in your registry and use the **value returned from `register()`**
  in the route response, not the original schema. zod-to-openapi treats the
  original and the named instance as separate schemas; only the named one
  emits a `$ref`.

- **Async codecs in input slots** under `tanstackReactQuery: true`. The
  generated `${opId}QueryKey` factory pre-encodes codec slots
  synchronously via `z.encode(Schema, value)` so the resulting key
  contains wire-shape strings, not the codec runtime values — that's
  what keeps the default `JSON.stringify`-based `queryKeyHashFn`
  hash-stable for `bigint` / `Date` inputs without consumer-side
  ceremony. If a codec's encode side runs an async transform, `z.encode`
  throws `$ZodAsyncError` at queryKey computation time. The error is
  clean (the codec name appears in the stack trace, the codegen-time
  warning isn't needed) but the limit is real: TanStack's queryKey
  getter can't be async, so an async-input codec is a hard "no" for
  routes you want to drive through `useQuery(...)`. The team's shipped
  codecs (`Int64Codec`, `BigIntegerCodec`, `DecimalStringCodec`,
  `IsoDateCodec`) are all sync and unaffected.

- **Error responses on routes with no `$ref` error schemas.** The
  plugin emits the error transformer + decoding wrapper only when the
  registry declares at least one error schema for the operation. Routes
  with `description: 'unauthorised'` and no schema get the wire-shape
  body on `result.error` regardless — there's nothing to decode
  against. Register a schema (e.g. via `ErrorResponse` from
  `@polygonlabs/openapi-registry/error-schemas`) to get the type/runtime
  parity treatment.

## Why `z.output<typeof Schema>` instead of walking the schema

The plugin defers to TypeScript's own resolution of Zod's type machinery via
`z.output<typeof Schema>`, rather than walking the schema's `_def` structure
to build TypeScript types directly.

Walking `_def` requires a dedicated branch for every Zod construct (tuples,
intersections, lazy, branded types, defaults, `ZodPipe` variants, `ZodReadonly`,
…), and any construct without a branch silently falls through to `unknown` —
the worst kind of bug, where types compile and the SDK looks fine until a
caller trips over it at runtime. `z.output<>` is automatically correct for
everything `z.infer` supports today and anything Zod adds tomorrow.

The trade-off is a type-only dependency on the schemas package in the generated
`.d.ts`. Since the generated runtime already calls `Schema.parseAsync(data)`
from that same package, this is honest about the actual coupling.
