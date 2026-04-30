# @polygonlabs/sync-github-releases

CLI tool that syncs GitHub Release bodies and titles from each package's
`CHANGELOG.md`, byte-equal to what
[`changesets/action`](https://github.com/changesets/action) emits natively.
Idempotent — the comparison is strict, so re-runs over an already-synced
repo report `[match]` and write nothing.

## When you'd reach for this

GitHub Releases produced by `changesets/action` (with
`createGithubReleases: true`) extract the `## <version>` section of the
matching package's `CHANGELOG.md` and post it as the release body. A few
situations leave releases that don't match that shape:

- **A new package's first release.** When CI tries to publish a brand-new
  `@scope/pkg` to npm, OIDC auth fails because no
  [trusted publisher](https://docs.npmjs.com/trusted-publishers) is
  configured for the package yet (and configuring one requires
  org-admin access). The standard recovery is to merge the Version
  Packages PR, accept the CI 403, and `pnpm exec changeset publish`
  locally. That path leaves the GitHub release with the wrong body
  (auto-generated PR list, or empty). Run this tool to sync it from
  `CHANGELOG.md`.
- **Migrating off `gh release create --generate-notes`.** Older release
  flows posted GitHub's repo-wide "what's changed" list as the body —
  fine for single-package repos, useless for monorepos. Run this once
  per repo to canonicalise historical bodies.

## Usage

`GH_TOKEN` must have `contents:write` on every target repo. The most
common source is `gh auth token`.

The tool has two subcommands: `release` for a single release in one repo
(the path you'll usually want), and `repos` for whole-repo sync across one
or more repos.

### `release <repo> <tag>` — most common

Use after a local recovery publish for one new package:

```bash
# Dry-run
GH_TOKEN=$(gh auth token) npx @polygonlabs/sync-github-releases \
  release 0xPolygon/apps-team-packages @polygonlabs/foo@1.0.0

# Apply (prompts for confirmation)
GH_TOKEN=$(gh auth token) npx @polygonlabs/sync-github-releases \
  release 0xPolygon/apps-team-packages @polygonlabs/foo@1.0.0 --apply

# Apply without prompting (after you've inspected a dry-run)
GH_TOKEN=$(gh auth token) npx @polygonlabs/sync-github-releases \
  release 0xPolygon/apps-team-packages @polygonlabs/foo@1.0.0 --apply --yes
```

### `repos <repo>...` — whole-repo, one or more

```bash
# Dry-run, one repo
GH_TOKEN=$(gh auth token) npx @polygonlabs/sync-github-releases \
  repos 0xPolygon/apps-team-packages

# Dry-run, multiple repos
GH_TOKEN=$(gh auth token) npx @polygonlabs/sync-github-releases \
  repos 0xPolygon/apps-team-packages 0xPolygon/proof-generation-api 0xPolygon/lst-api

# Apply across the lot
GH_TOKEN=$(gh auth token) npx @polygonlabs/sync-github-releases \
  repos 0xPolygon/apps-team-packages 0xPolygon/lst-api --apply
```

`--apply` runs the analysis pass first, then prints the count of
pending updates and prompts for confirmation. `--yes` / `-y` skips
the prompt; `--summary` suppresses per-release diffs (verdict lines
only).

The tool works from any directory — clones land in
`$TMPDIR/sync-github-releases/repos/<owner>-<name>/`, never the cwd.

## Output

Per release, one line:

| Marker | Meaning |
|---|---|
| `[match] <tag>` | Current body and title already byte-match the canonical extraction; nothing to do. |
| `[would-update] <tag>` | Dry-run; body or title would change. Followed by a diff of current vs. proposed. |
| `[updated] <tag>` | `--apply` mode; body was rewritten. |
| `[skip: no changelog match] <tag>` | Either no package matches the tag's `<name>@<version>` parse, or the package's `CHANGELOG.md` has no `## <version>` section. Skipped to avoid clobbering a real body with empty notes. |
| `[skip: tag unparseable] <tag>` | Tag is not in `<name>@<version>` or `@scope/name@version` form (e.g. `v1.0.0`). |

A per-repo summary is printed at the end.

## What it does

1. Shallow-clones each target repo into `$TMPDIR/sync-github-releases/repos/<owner>-<name>/`. Re-runs reuse the checkout, doing `git fetch && git reset --hard origin/<default-branch>`.
2. Walks every `package.json` in the clone (skipping `node_modules`, `.git`, `dist`) to build a `name → CHANGELOG.md` map.
3. Lists every release via Octokit `repos.listReleases` (paginated). The `release` subcommand filters down to the single tag; `repos` walks all of them.
4. For each release, parses the tag at the last `@`, looks up the matching `CHANGELOG.md`, and runs the canonical `getChangelogEntry` algorithm against the version. Output is serialised with `bullet: '-'`, `listItemIndent: 'tab'` to byte-match `changesets/action@v1.x`'s `remark-stringify@7` defaults.
5. Compares to the current release body and title. In dry-run, prints a diff. With `--apply`, calls `repos.updateRelease` with `name = tag` and `body = extracted`.

Releases whose tag doesn't parse, or whose package has no matching
`CHANGELOG.md` section, are skipped. The tool never replaces a populated
body with an empty one.

## Requirements

- Node.js ≥ 24
- `git` and `pnpm` on `$PATH` (used to clone target repos and enumerate their workspace packages)
- `GH_TOKEN` env var with `contents:write` on each target repo
