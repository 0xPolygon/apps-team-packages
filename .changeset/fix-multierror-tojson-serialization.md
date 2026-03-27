---
"@polygonlabs/verror": patch
---

`MultiError.toJSON()` now correctly serializes each error in the `errors` array.

Previously, spreading plain `Error` objects into the array produced `{}` entries when
the result was passed to `JSON.stringify`, because the `Error` class has no enumerable
own properties. The `errors` array is now mapped through `serializeError`, giving each
entry the same `{ name, message, shortMessage, cause, info }` shape as any other
serialized error in the cause chain.
