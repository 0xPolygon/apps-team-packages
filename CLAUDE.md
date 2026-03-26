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

After scaffolding the package under `packages/`, two root files must be updated:

- **`tsconfig.json`** — add a `references` entry pointing to the new package directory
- **`packages/<name>/eslint.config.js`** — pass `tsconfigRootDir: import.meta.dirname` to
  `typescript()` so `typescript-eslint` can resolve the correct tsconfig when ESLint runs
  from the repo root rather than the package directory
