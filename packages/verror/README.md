# @polygonlabs/verror

Structured error handling for TypeScript — cause chains, accumulated messages, and typed
`info` fields that survive serialisation.

Zero runtime dependencies. Pure ESM. Works in Node.js and browsers.

## Why not plain `Error`?

`new Error('query failed')` loses the context that caused it. You can attach a cause with
`new Error('query failed', { cause: dbErr })`, but the cause message disappears when you
log `err.message`, and `JSON.stringify(err)` produces `{}`.

`VError` solves both:

```ts
import { VError } from '@polygonlabs/verror';

const dbErr = new Error('connection refused');
const err = new VError('query failed', { cause: dbErr });

err.message;       // 'query failed: connection refused'
err.shortMessage;  // 'query failed'
JSON.stringify(err); // { name, message, shortMessage, cause: { ... }, info: {} }
```

The full cause chain accumulates into `message` at construction time. `shortMessage` gives
you back the message you actually passed, without the appended chain.

## Classes

### `VError`

The base class. Wraps any `Error` as a cause and appends its full accumulated message.

```ts
const root = new Error('ECONNREFUSED');
const err = new VError('upstream timed out', { cause: root });
// err.message === 'upstream timed out: ECONNREFUSED'
```

**Native `Error.cause` chains are walked automatically.** If the cause itself has a
`.cause` (ES2022 native cause), VError accumulates the whole chain — not just the
immediate cause message. This matters because third-party libraries and Node.js built-ins
increasingly set `.cause` directly:

```ts
const root = new Error('ECONNREFUSED');
const native = new Error('fetch failed', { cause: root });  // native ES2022 cause
const err = new VError('could not load config', { cause: native });

err.message; // 'could not load config: fetch failed: ECONNREFUSED'
//                                       ^^^^^^^^^^^^^^^^^^^^^^^^^^
//                                       full native chain accumulated
```

`serializeError` and `toJSON` also follow native cause chains, so the full chain is
preserved when serialising errors you did not create.

Structured context goes in `info`. Unlike the message, `info` fields are machine-readable
and aggregate up the chain via `VError.info()`:

```ts
const err1 = new VError('db error', { info: { table: 'users' } });
const err2 = new VError('request failed', { cause: err1, info: { requestId: 'abc' } });

VError.info(err2); // { table: 'users', requestId: 'abc' }
// Closer errors win on key conflicts.
```

### `WError` (Wrapped Error)

Like `VError` but intentionally does **not** append the cause's message. Use it when you
want to report a high-level outcome without the noise of the full cause chain in `message`:

```ts
const dbErr = new VError('query failed: connection refused');
const appErr = new WError('could not load user', { cause: dbErr });

appErr.message; // 'could not load user'  — cause message not appended
appErr.toString(); // 'WError: could not load user; caused by VError: query failed: ...'
```

The cause is still traversable — it just stays out of `message`. Use `WError` at service
boundaries where the cause is an internal detail that shouldn't leak into user-facing
strings.

### `MultiError`

Wraps multiple concurrent failures:

```ts
import { MultiError, errorFromList } from '@polygonlabs/verror';

const results = await Promise.allSettled(tasks);
const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
const err = errorFromList(errors); // null | Error | MultiError
```

`errorFromList` returns `null` for empty, the single error for one, and a `MultiError` for
many. `errorForEach` iterates either uniformly.

### HTTP errors

`HTTPError` base class and 17 concrete subclasses, each with a typed `statusCode`:

```ts
import { NotFound, BadRequest, Forbidden } from '@polygonlabs/verror';

throw new NotFound('user not found', { cause: dbErr, info: { userId } });
// err.statusCode === 404
// err.toJSON() includes statusCode
```

All subclasses: `BadRequest` (400), `NotAuthenticated` (401), `PaymentError` (402),
`Forbidden` (403), `NotFound` (404), `MethodNotAllowed` (405), `NotAcceptable` (406),
`Timeout` (408), `Conflict` (409), `Gone` (410), `LengthRequired` (411),
`Unprocessable` (422), `TooManyRequests` (429), `GeneralError` (500),
`NotImplemented` (501), `BadGateway` (502), `Unavailable` (503).

## Serialisation

`JSON.stringify` on a plain `Error` produces `{}` — the message and cause are lost.
`VError.toJSON()` is called automatically by `JSON.stringify` and produces:

```json
{
  "name": "VError",
  "message": "query failed: connection refused",
  "shortMessage": "query failed",
  "cause": { "name": "Error", "message": "connection refused", ... },
  "info": {}
}
```

To serialise an error you didn't create (e.g., from a `catch` block), use `serializeError`:

```ts
import { serializeError } from '@polygonlabs/verror';

try {
  await fetch(url);
} catch (err) {
  logger.error({ err: serializeError(err) }, 'fetch failed');
}
```

`serializeError` handles any value: returns `undefined` for non-Errors, delegates to
`toJSON()` for VErrors, and produces the same JSON shape for plain Errors and native
`Error.cause` chains.

## Static helpers

All available as standalone imports or as static methods on `VError`:

```ts
import { cause, info, fullStack, findCauseByName, findCauseByType } from '@polygonlabs/verror';
```

| Helper | Purpose |
|--------|---------|
| `cause(err)` | Immediate cause, or `null` |
| `info(err)` | Merged info from the full chain |
| `fullStack(err)` | Stack trace with all chained causes appended |
| `findCauseByName(err, name)` | First cause whose `.name` matches |
| `findCauseByType(err, Type)` | First cause that is `instanceof Type` |
| `hasCauseWithName(err, name)` | Boolean shorthand for `findCauseByName` |
| `hasCauseWithType(err, Type)` | Boolean shorthand for `findCauseByType` |
| `errorFromList(errors)` | `null` / single error / `MultiError` |
| `errorForEach(err, fn)` | Iterate errors, unwrapping `MultiError` |

`findCauseByName` is useful even when you control the code. Once errors cross a
serialisation boundary, or when multiple copies of this package exist in a dependency
tree, `instanceof` checks fail. Name-based lookup works regardless.

## Subclassing

Define the error name at the class level with `override readonly name = '...' as const`.
String literals survive minification; `new.target.name` does not:

```ts
class DatabaseError extends VError {
  override readonly name = 'DatabaseError' as const;
}

class QueryTimeoutError extends DatabaseError {
  override readonly name = 'QueryTimeoutError' as const;
}
```

Unnamed subclasses inherit the parent's name — useful for internal specialisation without
a new name at the error boundary:

```ts
class DatabaseError extends VError {
  override readonly name = 'DatabaseError' as const;
  constructor(message: string, options?: VErrorOptions) {
    super(message, { ...options, info: { ...options?.info, layer: 'db' } });
  }
}
```

## Differences from the original verror

This package is inspired by [`verror`](https://github.com/TritonDataCenter/node-verror) and
[`@openagenda/verror`](https://github.com/OpenAgenda/verror) but diverges in several
places. If you are migrating from either, here is what changed.

### Constructor API

The original constructor puts options or cause first, message last, and supports
printf-style format strings as additional arguments:

```ts
// original verror — multiple overloads
new VError(message)
new VError(options, message)
new VError(cause, message)
new VError(cause, 'failed to %s %d items', 'update', 42)
```

This package uses a single consistent signature — message first, options second:

```ts
// @polygonlabs/verror
new VError(message)
new VError(message, { cause, info })
```

**No sprintf.** Messages are plain strings. Printf-style formatting mixes presentation
into the error layer, produces hard-to-test messages, and makes the TypeScript types
awkward. Format at the call site if you need interpolation.

### Name is a class-level declaration

The original allowed setting `name` per instance via the options object:

```ts
new VError({ name: 'DatabaseError' }, 'query failed')  // original only
```

This package does not support per-instance names. `name` is a property of the class,
not the instance — set it with `override readonly name`:

```ts
class DatabaseError extends VError {
  override readonly name = 'DatabaseError' as const;
}
```

This makes the error type visible in TypeScript, survives minification (string literals
are not mangled), and is consistent with how the rest of the JavaScript ecosystem
defines error names.

### `WError` requires a cause

In the original, `WError` can be constructed without a cause. Here, `cause` is required
in the options — a `WError` with no cause is just a `VError`, so the constraint is
enforced at the type level.

### Native `Error.cause` chain accumulation

The original predates ES2022 `Error.cause`. When wrapping a native error that itself
has a `.cause`, the original sees only the immediate cause message. This package walks
the full native chain:

```ts
const root = new Error('ECONNREFUSED');
const native = new Error('upstream failed', { cause: root }); // ES2022 native cause
const err = new VError('request failed', { cause: native });

err.message; // 'request failed: upstream failed: ECONNREFUSED'
//                                                ^^^^^^^^^^^^ walked by this package
//                               ^^^^^^^^^^^^^^^ only this in original verror
```

`WError` still suppresses the entire cause chain from its own message, as expected.

### Serialisation

The original has no built-in serialisation support — `JSON.stringify(vErr)` produces
`{}` because `Error` properties are non-enumerable. This package implements `toJSON()`
on all error classes and provides `serializeError()` for errors you did not create.
The full cause chain is serialised recursively, including plain `Error` and native
`Error.cause` links.

### What was removed

- **`sprintf` / printf-style formatting** — use template literals instead
- **`name` in constructor options** — use `override readonly name` on the class
- **`strict` mode** — the option existed in some forks; not present here
- **`meta`** — appeared in some forks as a duplicate of `info`; not present here

### What was added

- **`serializeError()`** and `toJSON()` — full cause chain serialisation
- **Native `Error.cause` chain accumulation** — walks ES2022 cause chains
- **HTTP error classes** — `HTTPError` and 17 typed subclasses
- **Pure ESM, browser-compatible** — no `require`, no Node.js built-ins, zero
  runtime dependencies
