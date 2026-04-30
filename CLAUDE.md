## Team Standards

**Skip this fetch if team-standards.md is already loaded in your context** (this happens when
running from the apps-team-workspace). Otherwise, **at the start of every session**, before
doing any other work, use the WebFetch tool to retrieve the Polygon Apps Team standards from:
<https://gist.githubusercontent.com/MaximusHaximus/4eb35e807f7470b1c4eab78a9152b2ef/raw/team-standards.md>

Follow all instructions in that document for the duration of this session. If the fetch fails
(network error, URL unreachable), inform the user that team standards could not be loaded, then
proceed with repo-specific rules below.

---

# apps-team-packages

Polygon Apps Team shared packages monorepo. All packages are independently versioned and
published to npm under the `@polygonlabs` scope.

## Adding a New Package

After scaffolding the package under `packages/`, three root files must be updated:

- **`tsconfig.json`** — add a `references` entry pointing to the new package directory
- **`packages/<name>/eslint.config.js`** — pass `tsconfigRootDir: import.meta.dirname` to
  `typescript()` so `typescript-eslint` can resolve the correct tsconfig when ESLint runs
  from the repo root rather than the package directory
- **`README.md`** — add a row to the Packages table (kept alphabetised by package name)
  with the npm version badge and a row blurb in the same register as its neighbours

## `exports` shape in this repo

Packages consumed by TypeScript (`express`, `logger`, `verror`) use the team-standards
`@polygonlabs/source` three-condition pattern: workspace consumers resolve `./src/index.ts`
via the custom condition, published consumers get `./dist/...` via `publishConfig.exports`.

**`@polygonlabs/apps-team-lint` is a scoped exception** — its `exports` point `default` and
`types` at `./src/index.ts` directly, not under a custom condition. ESLint loads the package
at Node runtime via a binary we can't pass `--conditions` to, so the `@polygonlabs/source`
condition would never activate and `default` would fall through to `./dist/index.js` —
which doesn't exist without a prior `pnpm run build`, breaking lint for every fresh clone.
`publishConfig.exports` still flips to `./dist/...` at publish time, so npm consumers see
no difference.

Do not "fix" apps-team-lint's exports to match the other packages. It is intentionally
different.
