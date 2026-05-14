---
'@polygonlabs/zod-to-openapi-heyapi': minor
---

New entry: `@polygonlabs/zod-to-openapi-heyapi/errors`.

Small structural helpers for code paths that work across multiple
generated clients (logging adapters, generic error-reporting
middleware). Surface:

- `isTransportError`, `isUnknownError`, `isWrapperError` — same
  type-predicate guards the codegen emits per-client, but importable
  from the plugin itself for cross-client / no-import-cycle code.
- `TransportError`, `UnknownError` — structural `interface`s matching
  the codegen-emitted classes.
- `categorizeApiError(value)` — returns a discriminated union
  (`transport` / `unknown` / `native-error` / `other`).
  Deliberately no `'typed'` branch: the wrapper return already encodes
  the typed `${Op}Error` union statically, so consumers with the typed
  return in scope narrow with the codegen-emitted predicates directly.
  The `'other'` bucket carries values as `unknown` for consumer code
  to narrow with per-op types — never a magic-string convention here.
- `getApiErrorMessage(value, fallback?)` — returns `error.message`
  for `Error` instances, fallback otherwise.
- `TRANSPORT_ERROR_MARKER`, `UNKNOWN_ERROR_MARKER` — symbol-key
  constants for power users.

Import via the published subpath (`/errors`); the plugin's main entry
stays codegen-only.

```ts
import { categorizeApiError, isTransportError } from '@polygonlabs/zod-to-openapi-heyapi/errors';

const category = categorizeApiError(error);
switch (category.kind) {
  case 'transport':    /* category.error: TransportError */ break;
  case 'unknown':      /* category.error: UnknownError   */ break;
  case 'native-error': /* category.error: Error          */ break;
  case 'other':        /* category.error: unknown        */ break;
}
```

Same symbol-keyed markers the codegen-emitted guards check (the markers
come from the global `Symbol.for(...)` registry, so they're
identity-stable across realms / module copies / iframes / workers).
