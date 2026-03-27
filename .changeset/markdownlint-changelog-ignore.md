---
"@polygonlabs/apps-team-lint": major
---

## Breaking changes

**`markdownlint` and `commitlint` are now functions.** Call them to get the config:

```diff
-export default markdownlint;
+export default markdownlint();

-export default commitlint;
+export default commitlint();
```

**`markdownlint` and `commitlint` removed from the main entry point.** Import
from the subpath instead:

```diff
-import { markdownlint } from '@polygonlabs/apps-team-lint';
+import { markdownlint } from '@polygonlabs/apps-team-lint/markdownlint';

-import { commitlint } from '@polygonlabs/apps-team-lint';
+import { commitlint } from '@polygonlabs/apps-team-lint/commitlint';
```

## New

**`markdownlint()` accepts `config` and `ignores` overrides.** `ignores`
replaces the base ignore list — import `baseIgnores` to compose with it:

```js
import { baseIgnores, markdownlint } from '@polygonlabs/apps-team-lint/markdownlint';

markdownlint({ ignores: [...baseIgnores, '**/generated/**'] });
markdownlint({ config: { MD013: { line_length: 120 } } });
```

The `config` parameter is typed as `Configuration` from `markdownlint`.

**`baseIgnores` is now a named export** from
`@polygonlabs/apps-team-lint/markdownlint`.

**`CHANGELOG.md` excluded from linting.** Changelog files are auto-generated
by changesets — the generated structure reliably triggers MD022 and MD024
violations that `--fix` cannot resolve.
