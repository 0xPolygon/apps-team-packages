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
import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { $, defineConfig } from '@hey-api/openapi-ts';
import { registryPlugin } from '@polygonlabs/zod-to-openapi-heyapi';
import { myRegistry } from './schemas/registry.ts';

export default defineConfig({
  input: './openapi.json',
  output: { path: './src/generated', clean: true },
  plugins: [
    // Must be listed BEFORE @hey-api/typescript so the plugin's response-type
    // symbols are registered first; the SDK plugin queries by metadata key
    // and takes the first registered match.
    (await registryPlugin({
      registry: myRegistry,
      schemasFrom: '@my-org/api-schemas',
      generatorClass: OpenApiGeneratorV3,
      $
    })) as never,
    '@hey-api/typescript',
    '@hey-api/client-fetch',
    { name: '@hey-api/sdk', transformer: true }
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
deliberately boring pin point.

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

### When schemas live inside the client codegen package — use a `#imports` alias

Sometimes a project doesn't justify a separate schemas package: the schemas,
the registry, and the client codegen all live together. Relative paths
won't work — they mean different things to the plugin's audit (resolved
from the plugin's install location) and the generated client (resolved from
the output dir). Use a [`package.json#imports`][node-imports] alias:

```jsonc
// package.json
{
  "imports": {
    "#schemas": "./src/schemas/index.ts"
  }
}
```

```ts
// openapi-ts.config.ts
schemasFrom: '#schemas'
```

The alias resolves identically from any module within the package, so both
the audit (running from your `openapi-ts.config.ts`) and the generated
transformer (sitting under `./src/generated/`) reach the same file.

> **`#imports` aliases only work inside the package that declares them.**
> They do **not** cross package boundaries. If your schemas live in a
> sibling package or another workspace package, use the package name as
> shown above; a `#schemas` alias in the consumer's package.json will not be
> visible to the plugin or to a generated client that resolves the import
> from outside.

[node-imports]: https://nodejs.org/api/packages.html#subpath-imports

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
| Schemas in the same package as the codegen | `'#schemas'` (via `package.json#imports`) |

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
`$ref` from a route response**, verifies:

1. The module has a named export with that exact name.
2. The export is a Zod schema (duck-typed: has `_def` or a `parseAsync`
   method).

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

The audit walks **only** schemas that appear as a `$ref` in a route response.
Schemas registered for other purposes never reach the generated client and
don't need a matching Zod export:

- Path / query / header parameters registered via `registry.registerParameter(...)`.
  zod-to-openapi v8's `OpenApiGeneratorV3` lifts parameter schemas into
  `components.schemas` as well as `components.parameters` — the audit
  ignores them because the plugin doesn't emit any import for them.
- Request body schemas (the SDK plugin generates request types from the
  spec; no Zod transformer is involved on the request side).
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

## Plugin options

| Option | Type | Description |
|---|---|---|
| `registry` | `OpenAPIRegistry` | The same registry used to generate the OpenAPI spec. The plugin runs the same generator internally to discover schema names — no hardcoded list. |
| `schemasFrom` | `string` | Module specifier the generated client imports your schemas from. Must be unambiguous from any caller (package name, `#imports` alias, or `file://` URL — not a relative path). See [The `schemasFrom` option](#the-schemasfrom-option). |
| `generatorClass` | `OpenApiGeneratorV3` | Pass `OpenApiGeneratorV3` from `@asteasolutions/zod-to-openapi` explicitly. Avoids resolution ambiguity in the codegen environment. |
| `$` | `typeof $` | Pass `$` from `@hey-api/openapi-ts` explicitly. Same reason. |

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

Operations whose only responses are errors get the `Errors`/`Error` types but
no transformer (there's no success body to decode).

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

2. **Building blocks and parameter / query schemas can keep the `Schema`
   suffix.** The plugin's audit ignores them, and keeping the suffix
   distinguishes "this is a Zod schema, not a registered component" at call
   sites.

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
