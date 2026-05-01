/**
 * Re-exports the canonical error-response Zod schemas from
 * `@polygonlabs/openapi-registry/error-schemas`. They live there (not
 * here) so schemas-only packages can register the canonical response
 * shapes without taking a transitive dep on Express + pino + Sentry.
 *
 * This file exists only for back-compat: `@polygonlabs/express/registry`
 * still surfaces `ErrorResponseSchema` etc., so existing consumers keep
 * working unchanged. New code should import directly from
 * `@polygonlabs/openapi-registry/error-schemas`.
 */

export {
  ErrorResponseSchema,
  ValidationErrorInfoSchema,
  ValidationErrorResponseSchema,
  ZodErrorTreeSchema
} from '@polygonlabs/openapi-registry/error-schemas';

export type { ZodErrorTree } from '@polygonlabs/openapi-registry/error-schemas';
