---
'@polygonlabs/sync-github-releases': major
---

Initial release. CLI tool that syncs GitHub Release bodies and titles from each package's `CHANGELOG.md`, mirroring the canonical `changesets/action` algorithm so re-runs are idempotent. Dry-run by default; `--apply` writes via the GitHub API after a confirmation prompt.

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
