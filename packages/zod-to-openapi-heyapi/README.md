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
runtime `parseAsync` transformer; `@hey-api/client-fetch` runs the
transformer on every response, so codec decode (`"1500"` → `1500n`,
ISO string → `Date`, …) happens before the value reaches the caller and the
type and runtime agree.

[`@polygonlabs/zod-codecs`][codecs] ships the off-the-shelf codecs the team
reaches for (`Int64Codec`, `BigIntegerCodec`, `DecimalStringCodec`,
`IsoDateCodec`); this plugin works with any `z.codec(...)` schema, whether
imported or defined inline.

[codecs]: https://www.npmjs.com/package/@polygonlabs/zod-codecs

## Usage

```ts
import { defineConfig, $, OpenApiGeneratorV3 } from '@hey-api/openapi-ts';
import { registryPlugin } from '@polygonlabs/zod-to-openapi-heyapi';
import { myRegistry } from './schemas/registry.ts';

export default defineConfig({
  input: './openapi.json',
  output: { path: './src/client', clean: true, module: { extension: '.js' } },
  plugins: [
    // Must be listed BEFORE @hey-api/typescript so the plugin's response-type
    // symbols are registered first; the SDK plugin queries by metadata key
    // and takes the first registered match.
    await registryPlugin({
      registry: myRegistry,
      schemasFrom: '@my-org/my-schemas',
      generatorClass: OpenApiGeneratorV3,
      $
    }) as never,
    '@hey-api/typescript',
    '@hey-api/client-fetch',
    { name: '@hey-api/sdk', transformer: true }
  ]
});
```

`registryPlugin` is async — it dynamic-imports `schemasFrom` at codegen time
to run the audit described below. That dynamic import means **`schemasFrom`
must resolve the same way from any caller's perspective** — a published
package specifier (`'@org/pkg'`), a subpath export (`'@org/pkg/zod'`), a
package.json [`imports`][node-imports] alias (`'#schemas'`), or a `file://`
URL. Relative paths like `'../schemas'` don't work: they mean different
things to the plugin (resolving from its own module location at codegen time)
than to the generated client (resolving from the output dir at consumer
runtime).

For schemas that live inside your own package, the cleanest option is a
`package.json#imports` alias:

```json
{
  "imports": {
    "#schemas": "./src/schemas/index.ts"
  }
}
```

Then `schemasFrom: '#schemas'` works for both the audit (the plugin
dynamic-imports `'#schemas'`, Node resolves it via your package.json) and
the generated client (it imports `from '#schemas'`, Node resolves it the
same way at consumer runtime since both files live in the same package).

[node-imports]: https://nodejs.org/api/packages.html#subpath-imports

After `pnpm exec openapi-ts` runs, you'll find a generated
`registry-validator.gen.ts` alongside the rest of the client. Each operation's
response type is `z.output<typeof <Schema>>`, and each operation has a matching
`<opId>Transformer` function the SDK wires as the `responseTransformer`.

## The `schemasFrom` option

`schemasFrom` is the option that delivers schema-first end-to-end. It is the
module specifier baked into the generated transformer file's `import`
statement for every Zod schema the plugin references:

```ts
// Generated registry-validator.gen.ts
import { Foo, Bar } from '@my-org/api-schemas';   // ← this `from` value is `schemasFrom`
```

Set it to whatever specifier the **client's runtime environment** can resolve
to your schemas package. The same string also has to resolve at codegen time
(when the plugin dynamic-imports it for the audit), so it must be a
specifier with a single unambiguous meaning regardless of who's importing it:

| Setup                                  | Example                              |
| -------------------------------------- | ------------------------------------ |
| Schemas published to npm (root export) | `'@my-org/api-schemas'`              |
| Schemas published as a subpath export  | `'@my-org/api-schemas/zod'`          |
| Schemas in the same monorepo           | `'@my-org/api-schemas'` (workspace)  |
| Schemas in your own package            | `'#schemas'` (via `package.json#imports`) |

If your schemas package exposes them under a subpath (a common pattern when
the package also ships other exports), point `schemasFrom` at that subpath
directly — `'@my-org/api-schemas/zod'` is fine, as long as the package's
`exports` field declares it.

**Relative paths (`'../schemas'`) are not supported** — they mean different
things to the plugin (resolved from `node_modules/@polygonlabs/zod-to-openapi-heyapi/`)
and to the generated client (resolved from your output dir). Use a
`package.json#imports` alias instead; it gives one specifier that resolves
identically from any module within your package.

**Schemas must be named exports, and the export name must match the registry
name.** The plugin discovers schemas by walking the `OpenAPIRegistry` and
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

This is convention, not enforcement. `registry.register('Trade', tradeSchema)`
combined with `export const tradeSchema = ...` will codegen-pass but
import-fail at the consumer — the generated `import { Trade } from '...'`
won't resolve. Default or namespace exports don't work either; the generated
code is `import { name }`, always named.

The plugin doesn't bundle or copy schemas — it only writes the import. The
client package's `package.json` is responsible for declaring the dependency
that makes the specifier resolve at install time.

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
plugin dynamic-imports `schemasFrom` and, for every schema registered in
the `OpenAPIRegistry`, verifies:

1. The module has a named export with that exact name.
2. The export is a Zod schema (duck-typed: has `_def` or a `parseAsync`
   method).

Mismatches fail the codegen step with an aggregated error listing every
issue at once, so a typo or forgotten export surfaces immediately on the
developer's machine instead of as a confusing import error in a downstream
consumer's build.

```text
[zod-to-openapi-heyapi] codegen-time audit found 2 issues:
  - 'Customer' is registered in the OpenAPIRegistry but is not a named export
    of '@my-org/my-schemas'. The plugin emits `import { Customer } from
    '@my-org/my-schemas'`, which will fail at consumer build time. Either
    export Customer from that module, or unregister it.
  - 'Order' is exported from '@my-org/my-schemas' but does not appear to be
    a Zod schema (got string). The plugin emits `Order.parseAsync(data)`,
    which will fail at consumer runtime.
```

## Plugin options

| Option           | Type                | Description                                                                                                                                       |
| ---------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registry`       | `OpenAPIRegistry`     | The same registry used to generate the OpenAPI spec. The plugin runs the same generator internally to discover schema names — no hardcoded list. |
| `schemasFrom`    | `string`              | Module specifier the generated client imports your schemas from. Must be unambiguous from any caller (package name, `#imports` alias, or `file://` URL — not a relative path). See [The `schemasFrom` option](#the-schemasfrom-option). |
| `generatorClass` | `OpenApiGeneratorV3`  | Pass `OpenApiGeneratorV3` from `@asteasolutions/zod-to-openapi` explicitly. Avoids resolution ambiguity in the codegen environment.              |
| `$`              | `typeof $`            | Pass `$` from `@hey-api/openapi-ts` explicitly. Same reason.                                                                                      |

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
that declare more than one response (see [Multi-status responses](#multi-status-responses)).
`Response` is `Responses[keyof Responses]` — the union of bodies across
every declared status.

The SDK plugin (`@hey-api/sdk` with `transformer: true`) wires
`responseTransformer: getFooTransformer` onto the route's call options, so
`@hey-api/client-fetch` runs the transformer on the raw JSON response and
the codec decode reaches the caller.

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

`@hey-api/client-fetch` invokes the response transformer for any 2xx status,
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
