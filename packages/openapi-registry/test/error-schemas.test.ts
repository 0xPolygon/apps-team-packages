/**
 * Smoke tests for the canonical error response schemas now living in
 * `@polygonlabs/openapi-registry`. The express package re-exports these
 * for back-compat — the matching test in `@polygonlabs/express` covers
 * the re-export path.
 *
 * Each schema parses the shape `@polygonlabs/express`'s `createErrorHandler`
 * actually emits, and survives `OpenApiGeneratorV3` round-trip as a `$ref`
 * under `components.schemas`.
 */

import { OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { describe, expect, it } from 'vitest';

import {
  ErrorResponseSchema,
  ValidationErrorInfoSchema,
  ValidationErrorResponseSchema,
  ZodErrorTreeSchema
} from '../src/error-schemas.ts';

describe('error response schemas', () => {
  describe('ErrorResponseSchema', () => {
    it('parses a minimal HTTPError shape (no info)', () => {
      expect(ErrorResponseSchema.parse({ error: true, message: 'Not authorized' })).toEqual({
        error: true,
        message: 'Not authorized'
      });
    });

    it('parses a shape with arbitrary info', () => {
      const result = ErrorResponseSchema.parse({
        error: true,
        message: 'Failed',
        info: { tenantId: 'abc', cause: { stack: 'omitted' } }
      });
      expect(result.info).toEqual({ tenantId: 'abc', cause: { stack: 'omitted' } });
    });

    it('rejects when error is not the literal true', () => {
      expect(() => ErrorResponseSchema.parse({ error: false, message: 'x' })).toThrow();
    });
  });

  describe('ValidationErrorResponseSchema', () => {
    it('parses the section-keyed treeify shape from createRequestValidator', () => {
      const result = ValidationErrorResponseSchema.parse({
        error: true,
        message: 'Invalid request',
        info: {
          body: {
            errors: [],
            properties: {
              label: { errors: ['Required'] },
              age: { errors: ['Must be positive'] }
            }
          }
        }
      });
      expect(result.info.body?.properties?.label?.errors).toEqual(['Required']);
    });

    it('rejects when info is missing (shape is non-optional here)', () => {
      expect(() =>
        ValidationErrorResponseSchema.parse({ error: true, message: 'Invalid request' })
      ).toThrow();
    });
  });

  describe('ZodErrorTreeSchema', () => {
    it('parses a deeply nested tree', () => {
      const result = ZodErrorTreeSchema.parse({
        errors: [],
        properties: {
          outer: {
            errors: [],
            items: [
              { errors: ['Item 0 invalid'] },
              {
                errors: [],
                properties: {
                  inner: { errors: ['nested message'] }
                }
              }
            ]
          }
        }
      });
      expect(result.properties?.outer?.items?.[1]?.properties?.inner?.errors).toEqual([
        'nested message'
      ]);
    });
  });

  describe('OpenAPI generator round-trip', () => {
    it('emits the schemas as $refs under components.schemas', () => {
      const registry = new OpenAPIRegistry();
      registry.register('ErrorResponse', ErrorResponseSchema);
      registry.register('ValidationErrorResponse', ValidationErrorResponseSchema);
      registry.register('ValidationErrorInfo', ValidationErrorInfoSchema);
      registry.register('ZodErrorTree', ZodErrorTreeSchema);

      const doc = new OpenApiGeneratorV3(registry.definitions).generateDocument({
        openapi: '3.0.0',
        info: { title: 'test', version: 'v1' }
      });

      const schemas = doc.components?.schemas ?? {};
      expect(schemas.ErrorResponse).toBeDefined();
      expect(schemas.ValidationErrorResponse).toBeDefined();
      expect(schemas.ValidationErrorInfo).toBeDefined();
      expect(schemas.ZodErrorTree).toBeDefined();
    });
  });
});
