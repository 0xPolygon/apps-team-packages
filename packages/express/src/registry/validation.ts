/**
 * Request and response validation middleware factories.
 *
 * Both validators are pure functions of the route config and Zod schemas —
 * no Express-specific knowledge beyond `RequestHandler` shape.
 * `createRequestValidator` runs Zod parsing on `req.params/query/body/headers`
 * (replacing them with the codec-decoded runtime shapes) before the handler
 * runs. `createResponseValidator` patches `res.json` to encode the runtime
 * shape back to wire (via `z.encode`) before sending — preserving the
 * codec round-trip on outbound responses too.
 *
 * On a request validation failure, the validator collects every section's
 * failures (params, query, body, headers) and throws a single `BadRequest`
 * from `@polygonlabs/verror` whose `info` is keyed by section name with
 * each value the `z.treeifyError` tree for that section. The global error
 * handler answers 400 by mapping `HTTPError.statusCode` and surfaces the
 * full info to the response body, so a single round trip tells the client
 * everything that's wrong instead of fix-one-resubmit-discover-the-next.
 *
 * On a response validation failure (encode-side error from a misbehaving
 * handler), the patched `res.json` forwards the `ZodError` to `next(err)`
 * so the global error handler answers 500. Strict by default.
 */

import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import type { RequestHandler } from 'express';

import { z } from 'zod';

import { BadRequest } from '@polygonlabs/verror';

/**
 * Walks RouteConfig's `application/json` schema slot. Returns the Zod schema
 * if it's a Zod schema, undefined otherwise (the slot can also hold a raw
 * OpenAPI SchemaObject or a ReferenceObject — those aren't validated here).
 */
function jsonSchema(content: unknown): z.ZodType | undefined {
  if (!content || typeof content !== 'object') return undefined;
  const ct = (content as Record<string, unknown>)['application/json'];
  if (!ct || typeof ct !== 'object') return undefined;
  const schema = (ct as { schema?: unknown }).schema;
  if (schema instanceof z.ZodType) return schema;
  return undefined;
}

/**
 * Section name → `z.treeifyError` output for that section. The tree mirrors
 * the section's input shape with `errors: string[]` at every level plus
 * `properties` for object branches and `items` for array branches. Clients
 * read e.g. `info.body.properties.label.errors[0]` to populate field-level
 * error feedback directly rather than walking a path array themselves.
 */
type ValidationFailures = {
  params?: ReturnType<typeof z.treeifyError>;
  query?: ReturnType<typeof z.treeifyError>;
  body?: ReturnType<typeof z.treeifyError>;
  headers?: ReturnType<typeof z.treeifyError>;
};

export function createRequestValidator(op: RouteConfig): RequestHandler {
  // Reject the array-form `request.headers` schema at validator setup time
  // (server startup, when `router.toExpress()` materialises operations) so
  // a misconfigured route fails loudly before serving any traffic.
  //
  // `RouteConfig` types `request.headers` as `RouteParameter | ZodType[]`.
  // The array form is asteasolutions's "registered parameter" pattern —
  // each element is a single-header schema whose name lives in
  // `.openapi({ param: { name: 'x-foo' } })` metadata, accessible only via
  // a private asteasolutions registry. We don't reach into that internal
  // API, and the object form (`z.object({ 'x-foo': z.string() })`) is
  // strictly more flexible for validation: same OpenAPI output, all
  // headers in one schema, required/optional natural, and the same
  // `z.treeifyError` shape we use for every other section.
  if (Array.isArray(op.request?.headers)) {
    throw new Error(
      `@polygonlabs/express/registry: operation '${op.operationId ?? op.path}' ` +
        `uses the array-form request.headers schema (an array of ZodType), ` +
        `which is not supported. Use the object form instead — ` +
        `\`request.headers: z.object({ 'x-foo': z.string() })\` — which ` +
        `produces the same OpenAPI output and validates uniformly with the ` +
        `other request sections.`
    );
  }

  return async (req, _res, next) => {
    try {
      const failures: ValidationFailures = {};

      // Validate every section before deciding whether to fail. Collecting
      // all failures in one pass means a 400 response carries every
      // problem the client needs to fix — params, query, body, and headers
      // all surfaced at once — rather than the fix-one-resubmit-find-the-
      // next-one round trip that short-circuiting on the first error
      // produces. Eager mutation on success is fine: if any section
      // failed, the throw below routes to the error handler before the
      // route handler ever runs, so the partially-mutated req is never
      // observed.
      if (op.request?.params instanceof z.ZodType) {
        const result = await op.request.params.safeParseAsync(req.params);
        if (result.success) {
          // Mutate in place so existing `req.params` reference seen by
          // other middleware stays consistent with the parsed value.
          for (const key of Object.keys(req.params)) delete req.params[key];
          Object.assign(req.params, result.data as Record<string, unknown>);
        } else {
          failures.params = z.treeifyError(result.error);
        }
      }
      if (op.request?.query instanceof z.ZodType) {
        const result = await op.request.query.safeParseAsync(req.query);
        if (result.success) {
          Object.defineProperty(req, 'query', { value: result.data, configurable: true });
        } else {
          failures.query = z.treeifyError(result.error);
        }
      }
      const bodySchema = jsonSchema(op.request?.body?.content);
      if (bodySchema) {
        const result = await bodySchema.safeParseAsync(req.body);
        if (result.success) {
          req.body = result.data;
        } else {
          failures.body = z.treeifyError(result.error);
        }
      }
      // The array form was rejected at setup time (see top of this
      // function), so by here `op.request?.headers` is either undefined
      // or a single Zod schema (the object form).
      if (op.request?.headers instanceof z.ZodType) {
        const result = await op.request.headers.safeParseAsync(req.headers);
        if (!result.success) {
          failures.headers = z.treeifyError(result.error);
        }
      }

      if (Object.keys(failures).length > 0) {
        throw new BadRequest('Invalid request', { info: failures });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

export function createResponseValidator(op: RouteConfig): RequestHandler {
  return (_req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = function patchedJson(body: unknown) {
      const status = res.statusCode || 200;
      const responseConfig = op.responses[status];
      const schema =
        responseConfig && 'content' in responseConfig
          ? jsonSchema(responseConfig.content)
          : undefined;
      if (!schema) {
        // No schema for this status — pass through. Handlers may emit
        // statuses outside the registry (e.g. middleware-issued 401s).
        return originalJson(body);
      }

      // patchedJson must return Response synchronously to match res.json's
      // contract (so chains like `res.status(201).json(body)` still work),
      // but the encode side is async — so the actual serialise-and-send
      // step is deferred into an IIFE that runs after the handler returns.
      // Express keeps the response open until originalJson eventually
      // calls res.end via res.send, so the handler returning before that
      // completes is fine.
      //
      // The single try/catch covers every failure mode in one place:
      //   - z.encode rejecting (body doesn't match the declared response
      //     runtime type, or a codec encode-side validation fails);
      //   - z.encode throwing synchronously (defensive — Zod returns a
      //     promise normally, but a sync throw from the await line is
      //     still routed through next);
      //   - originalJson itself throwing (vanishingly unlikely after
      //     a successful encode produces JSON-safe output, but
      //     defensive — without the catch, a throw here would surface
      //     as an unhandled rejection rather than a 500 response).
      //
      // z.encode runtime → wire: validates that `body` matches the
      // declared response runtime type, then runs codec encode to produce
      // JSON-safe output (bigint → digit string for Int64Codec, Date → ISO
      // string for IsoDateCodec, etc). Non-codec fields are identity.
      void (async () => {
        try {
          const encoded = await z.encode(schema, body);
          originalJson(encoded);
        } catch (err) {
          next(err);
        }
      })();

      return res;
    };
    next();
  };
}
