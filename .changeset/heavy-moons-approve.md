---
'@polygonlabs/express': minor
---

Registry router now runs request validation before auth handlers

The registry-driven router previously ran an operation's auth handlers before
validating the request, so auth handlers saw the raw parsed input and had to
re-validate anything they read from it. Validation now runs first: a malformed
request to any operation — including auth-protected ones — gets an immediate
`400 Bad Request` with the canonical validation-error body, and auth handlers
only ever run for well-formed requests, receiving the validated, codec-decoded
`req.params` / `req.query` / `req.body`.

## Behaviour changes

- A request that fails schema validation on an operation declaring `security`
  now returns `400` even when credentials are missing or invalid. Previously
  auth ran first and such requests returned `401` / `403`.
- Auth handlers now observe the validated, decoded request sections rather
  than the raw parsed input. Handlers that defensively re-parsed the body
  through their own schema keep working, but that re-parse is now redundant
  and can be deleted.
- Validation errors (field names and constraints from the request schema) are
  now visible to unauthenticated callers on protected routes. The schemas are
  already published in the OpenAPI document, so nothing secret is exposed.
