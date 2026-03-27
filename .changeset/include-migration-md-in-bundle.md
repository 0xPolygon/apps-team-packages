---
"@polygonlabs/apps-team-lint": patch
"@polygonlabs/logger": patch
"@polygonlabs/verror": patch
---

`MIGRATION.md` is now included in the published npm bundle.

Previously, `MIGRATION.md` was present in the repository but absent from the `files`
allowlist in `package.json`, so it was silently dropped when packages were published
to the registry. Consumers who installed a package and looked for migration guidance
would find no file. Adding `"MIGRATION.md"` to `files` ensures it ships alongside
`dist/` in every release.
