/**
 * Canonical Zod schemas for the error response shapes that the
 * registry-driven router (in concert with `createErrorHandler`) emits.
 * Consumers reference these from their `responses[code].content` slots so
 * the OpenAPI spec accurately documents what clients will actually see —
 * with no copy-pasted-and-drifting per-service definitions.
 *
 *   - `ErrorResponseSchema` — the generic shape `createErrorHandler`
 *     emits for any `HTTPError` (401, 403, 409, …) and for non-HTTPError
 *     500s. `info` is permissive (`Record<string, unknown>`) since the
 *     content varies by error type.
 *   - `ValidationErrorResponseSchema` — narrowed shape for the 400
 *     emitted by `createRequestValidator`. `info` is keyed by section
 *     name (`params`, `query`, `body`, `headers`) with each value the
 *     `z.treeifyError` tree for that section.
 *   - `ValidationErrorInfoSchema` / `ZodErrorTreeSchema` — the building
 *     blocks for the above; exported in case a consumer wants to
 *     reference the tree shape directly (e.g. a domain-specific error
 *     that wraps a partial tree).
 *
 * Each schema is registered with `.openapi('Name', …)` so the
 * asteasolutions OpenAPI generator emits it as a `$ref` under
 * `components.schemas` rather than inlining the definition at every use
 * site. The registry just needs to see it on the schema's metadata —
 * which `extendZodWithOpenApi(z)` (called once at module load below)
 * sets up.
 */

import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

/**
 * Recursive shape returned by `z.treeifyError`. Each node carries
 * top-level errors plus optional `properties` (object branches) and
 * `items` (array branches) for nested errors.
 */
export type ZodErrorTree = {
  errors: string[];
  properties?: Record<string, ZodErrorTree>;
  items?: ZodErrorTree[];
};

export const ZodErrorTreeSchema: z.ZodType<ZodErrorTree> = z
  .lazy(() =>
    z.object({
      errors: z.array(z.string()),
      properties: z.record(z.string(), ZodErrorTreeSchema).optional(),
      items: z.array(ZodErrorTreeSchema).optional()
    })
  )
  .openapi('ZodErrorTree', {
    description:
      'Recursive Zod validation error tree (the output of `z.treeifyError`). ' +
      '`errors` carries the messages at this node; `properties` keys nested ' +
      'object errors by field name; `items` indexes nested array errors.'
  });

export const ValidationErrorInfoSchema = z
  .object({
    params: ZodErrorTreeSchema.optional(),
    query: ZodErrorTreeSchema.optional(),
    body: ZodErrorTreeSchema.optional(),
    headers: ZodErrorTreeSchema.optional()
  })
  .openapi('ValidationErrorInfo', {
    description:
      'Section-keyed map of request validation failures. Only sections that ' +
      'failed appear; each value is the `z.treeifyError` tree for that section. ' +
      'Clients can wire e.g. `info.body.properties.label.errors[0]` directly into ' +
      'field-level UI feedback rather than walking a flat issue list.'
  });

export const ErrorResponseSchema = z
  .object({
    error: z.literal(true),
    message: z.string(),
    info: z.record(z.string(), z.unknown()).optional()
  })
  .openapi('ErrorResponse', {
    description:
      "Standard error response shape from `@polygonlabs/express`'s " +
      '`createErrorHandler`. `info` is present when the underlying `HTTPError` ' +
      'carries structured info (e.g. validation failures, domain-specific context); ' +
      'absent for plain errors and most non-validation HTTPErrors.'
  });

export const ValidationErrorResponseSchema = z
  .object({
    error: z.literal(true),
    message: z.string(),
    info: ValidationErrorInfoSchema
  })
  .openapi('ValidationErrorResponse', {
    description:
      'Narrowed `ErrorResponse` for 400s emitted by the registry-driven router ' +
      'when request validation fails. `info` is non-optional and carries the ' +
      'section-keyed `ValidationErrorInfo` shape.'
  });
