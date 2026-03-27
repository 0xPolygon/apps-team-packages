---
"@polygonlabs/verror": major
"@polygonlabs/logger": patch
---

Introduces `@polygonlabs/verror` — a TypeScript-first rewrite of `@openagenda/verror` with
full browser and Node.js support.

## What it provides

- **`VError`** — the base error class. The cause's message is appended to the wrapping
  message (`"wrapper: root cause"`), and `info` fields accumulate through the cause chain
  via `VError.info()`.
- **`WError`** — a "wrapped error" that keeps the cause message separate from the error's
  own message, preventing ever-growing message strings in deep cause chains.
- **`MultiError`** — a container for multiple concurrent errors.
- **`HTTPError`** base class and 17 concrete subclasses (`BadRequest`, `NotFound`,
  `Forbidden`, etc.) with a typed `statusCode` property and `toJSON()` that includes it.
- **`serializeError(err)`** — serialises any `Error` (including plain errors and native
  ES2022 `Error.cause` chains) to the same JSON shape as `VError.toJSON()`, so the full
  cause chain is preserved when errors cross RPC boundaries or land in structured logs.
- **Static helpers** also exported as standalone named functions:
  `cause`, `info`, `fullStack`, `findCauseByName`, `findCauseByType`,
  `hasCauseWithName`, `hasCauseWithType`, `errorFromList`, `errorForEach`

## Why

The original `verror` npm package ships only CommonJS and relies on Node-specific patterns
that break in modern ESM environments and bundlers. `@openagenda/verror` added browser
support but remains JavaScript-only with no TypeScript types and no active maintenance.
This package re-implements the same semantics in TypeScript with a clean ESM build, proper
type declarations, and team-standard tooling.

Zero runtime dependencies. Plain string messages only (no printf-style formatting).

## Usage

```ts
import { VError, WError, NotFound, serializeError } from '@polygonlabs/verror';

const root = new Error('database unavailable');
const err = new VError('query failed', { cause: root, info: { requestId: 'abc' } });

throw new NotFound('resource not found', { cause: err });
```

`@polygonlabs/logger` has been updated to use `@polygonlabs/verror` as its error wrapper,
replacing the external `verror` dependency.
