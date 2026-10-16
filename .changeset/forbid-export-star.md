---
'@polygonlabs/apps-team-lint': minor
---

Forbid `export * from '…'` and `export * as ns from '…'` in `recommended()`

Barrels must now list their re-exports explicitly, values in `export { … }` and types in `export type { … }`. A star re-export hides which names are types, so it silently pulls them through as values and slips past `@typescript-eslint/consistent-type-exports`.

The rule is an error, so repos that still use `export *` will fail lint on upgrade. See [MIGRATION.md](./MIGRATION.md#export--ban) for how to fix each case. If your config sets `no-restricted-syntax` itself, add the `ExportAllDeclaration` selector to it, since ESLint replaces rather than merges a rule's options.
