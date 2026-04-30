/**
 * OpenAPI-style ↔ Express-style path conversion.
 *
 * OpenAPI paths use `{name}` for parameters; Express uses `:name`. The
 * registry-driven router declares paths once in OpenAPI form (where the spec
 * lives) and registers them on Express in `:name` form. Coverage checks
 * run the inverse direction to compare manifests.
 */

const OPENAPI_PARAM = /\{([^}]+)\}/g;
const EXPRESS_PARAM = /:([A-Za-z0-9_]+)/g;

/** `/users/{id}/posts/{postId}` → `/users/:id/posts/:postId` */
export function openApiToExpressPath(path: string): string {
  return path.replace(OPENAPI_PARAM, ':$1');
}

/** `/users/:id/posts/:postId` → `/users/{id}/posts/{postId}` */
export function expressToOpenApiPath(path: string): string {
  return path.replace(EXPRESS_PARAM, '{$1}');
}
