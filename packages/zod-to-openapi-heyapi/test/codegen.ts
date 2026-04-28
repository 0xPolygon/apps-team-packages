// Standalone runner for the test-fixture codegen.
//
// Invokes the same setup() that vitest's globalSetup uses, so `__generated__/`
// can be produced ahead of `tsc --noEmit` and `eslint .` — both of which
// otherwise fail on a fresh checkout because `test/api.test.ts` and
// `test/types.test.ts` import from the generated client.
//
// Idempotent: setup() rmSync's the directory first. Running it before
// vitest is harmless — vitest's globalSetup just regenerates from scratch.

import { setup } from './setup.ts';

await setup();
