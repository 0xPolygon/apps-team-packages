import { describe, expect, it } from 'vitest';

import { expressToOpenApiPath, openApiToExpressPath } from '../../src/registry/index.ts';

describe('pathMatching', () => {
  describe('openApiToExpressPath', () => {
    it('converts a single-parameter path', () => {
      expect(openApiToExpressPath('/users/{id}')).toBe('/users/:id');
    });

    it('converts a multi-parameter nested path', () => {
      expect(openApiToExpressPath('/orgs/{orgId}/users/{userId}/posts/{postId}')).toBe(
        '/orgs/:orgId/users/:userId/posts/:postId'
      );
    });

    it('leaves a path with no parameters unchanged', () => {
      expect(openApiToExpressPath('/health-check')).toBe('/health-check');
    });
  });

  describe('expressToOpenApiPath', () => {
    it('converts a single-parameter path', () => {
      expect(expressToOpenApiPath('/users/:id')).toBe('/users/{id}');
    });

    it('converts a multi-parameter nested path', () => {
      expect(expressToOpenApiPath('/orgs/:orgId/users/:userId/posts/:postId')).toBe(
        '/orgs/{orgId}/users/{userId}/posts/{postId}'
      );
    });

    it('leaves a path with no parameters unchanged', () => {
      expect(expressToOpenApiPath('/health-check')).toBe('/health-check');
    });
  });

  describe('round-trip', () => {
    it.each([
      '/users/{id}',
      '/orgs/{orgId}/users/{userId}/posts/{postId}',
      '/api/blocks/{blockNumber}',
      '/health-check'
    ])('preserves %s through OpenAPI -> Express -> OpenAPI', (path) => {
      expect(expressToOpenApiPath(openApiToExpressPath(path))).toBe(path);
    });
  });
});
