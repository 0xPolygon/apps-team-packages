---
"@polygonlabs/zod-to-openapi-heyapi": major
---

Generated clients' `TransportError` and `ResponseValidationError` now extend `@polygonlabs/verror`'s `VError` instead of the bare `Error` global, so consumers get `VError.info()`, `serializeError()`, and cause-chain helpers for free on wrapper-emitted errors.

## Breaking change

Install the new required runtime peer dependency, then regenerate your client:

```sh
pnpm add @polygonlabs/verror
```

## Behaviour changes

- `.message` now includes the accumulated cause message. The as-constructed message alone is available as `.shortMessage`.
- `ResponseValidationError.body` is now a getter backed by `VError`'s `info` bag — `error.body` still reads the same way, and `VError.info(error).body` / `serializeError(error)` now see it too.
- `isTransportError`, `isResponseValidationError`, `isWrapperError`, and their marker symbols are unchanged — existing narrowing code keeps working.
