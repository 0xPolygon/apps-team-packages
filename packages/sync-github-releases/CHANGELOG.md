# @polygonlabs/sync-github-releases

## 1.0.4

### Patch Changes

- [#73](https://github.com/0xPolygon/apps-team-packages/pull/73) [`006cf08`](https://github.com/0xPolygon/apps-team-packages/commit/006cf081e794bb156cee0f37fabc450c5b03e7c5) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Ship the LICENSE file inside the published npm package

  The previous release added the Apache-2.0 license at the repo root and
  declared it in package.json, but npm only auto-includes a LICENSE file
  in the packed tarball when it lives in the same directory as the
  package's own package.json. The license metadata was correct but the
  actual license text was missing from the published package — this adds
  it.

## 1.0.3

### Patch Changes

- [#71](https://github.com/0xPolygon/apps-team-packages/pull/71) [`aa81b1a`](https://github.com/0xPolygon/apps-team-packages/commit/aa81b1a73e0b4711d195c12e12120f5f67191305) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Add Apache-2.0 license: the package now declares `"license": "Apache-2.0"` in its `package.json`, and the repository carries the full Apache License 2.0 text. Previously no license was declared.

## 1.0.2

### Patch Changes

- f1d7c26: `release <repo> <tag>` now creates the GitHub release if one doesn't exist yet, instead of erroring with `[error] tag '...' not found`. This is the typical state after the local recovery publish a new package's first release goes through (`pnpm exec changeset publish` creates the npm publish and the git tag, but no GitHub release object).

  Behaviour:
  - GitHub release exists, body matches CHANGELOG → `[match]`, no write.
  - GitHub release exists, body differs → `[would-update]` / `[updated]`, same as before.
  - **No GitHub release, but the underlying git tag exists** → `[would-create]` / `[created]`. Body extracted from `CHANGELOG.md` the same way as the update path.
  - No GitHub release and no matching git tag → `[error] tag '…' not found … and no matching git tag`. Same fail-fast as before for the genuine missing-tag case.

  The `repos` subcommand is unchanged — it only walks existing GitHub releases.

  Per-repo summary now also reports `created=N` alongside `updated=N`.

## 1.0.1

### Patch Changes

- 7b119a4: Drop the `gh` CLI runtime dependency. The tool now clones target repos directly via `git`, passing `GH_TOKEN` through `git -c http.<base>.extraheader=AUTHORIZATION:...` rather than shelling out to `gh repo clone`. The token is set per-invocation, never written into `.git/config`.

  Fixes the `ERROR: 'gh' was not found on PATH` failure for engineers who have `gh` aliased to a non-standard install location (where the alias is invisible to subprocesses Node spawns).

  For consumers with `url.git@github.com:.insteadof=https://github.com/` in their git config, the HTTPS URL transparently rewrites to SSH and the extraheader is silently ignored — SSH key auth handles authentication. Both setups work without per-environment branching.

## 1.0.0

### Major Changes

- bb588b5: Initial release. CLI tool that syncs GitHub Release bodies and titles from each package's `CHANGELOG.md`, mirroring the canonical `changesets/action` algorithm so re-runs are idempotent. Dry-run by default; `--apply` writes via the GitHub API after a confirmation prompt.

  Two subcommands:

  ```bash
  # Sync just one release (typical for a fresh package's first publish)
  GH_TOKEN=$(gh auth token) npx @polygonlabs/sync-github-releases \
    release 0xPolygon/apps-team-packages @polygonlabs/foo@1.0.0 --apply

  # Sync every release across one or more repos
  GH_TOKEN=$(gh auth token) npx @polygonlabs/sync-github-releases \
    repos 0xPolygon/apps-team-packages 0xPolygon/lst-api --apply
  ```

  Reach for it whenever a release body is out of sync with what `changesets/action` would write — most commonly after the local recovery publish that follows the standard CI 403 on a brand-new package's first release (no trusted publisher configured yet on npm), or when migrating a repo from `gh release create --generate-notes` to the canonical extractor.
