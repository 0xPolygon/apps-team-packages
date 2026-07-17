---
"@polygonlabs/zod-to-openapi-heyapi": patch
---

Raise the minimum supported `@hey-api/openapi-ts` to 0.97.3, which resolves a security advisory affecting earlier releases.

The `@hey-api/openapi-ts` peer dependency floor is now `>=0.97.3` (previously `>=0.95.0`). Update your `@hey-api/openapi-ts` dependency to 0.97.3 or later and regenerate your clients — the bundled runtime templates (`client.gen.ts` and friends) change between these versions.
