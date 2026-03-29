---
"@polygonlabs/apps-team-lint": patch
---

Underscore-prefixed variables and parameters no longer trigger the unused-vars error.

Overrides `@typescript-eslint/no-unused-vars` from `tseslint.configs.recommended` to add
`argsIgnorePattern` and `varsIgnorePattern` matching `/^_/`, restoring the conventional
behaviour where a leading underscore signals an intentionally unused name — most commonly
needed for the mandatory fourth parameter in Express error-handling middleware.
