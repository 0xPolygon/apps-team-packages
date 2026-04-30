---
'@polygonlabs/sync-github-releases': patch
---

`release <repo> <tag>` now creates the GitHub release if one doesn't exist yet, instead of erroring with `[error] tag '...' not found`. This is the typical state after the local recovery publish a new package's first release goes through (`pnpm exec changeset publish` creates the npm publish and the git tag, but no GitHub release object).

Behaviour:

- GitHub release exists, body matches CHANGELOG → `[match]`, no write.
- GitHub release exists, body differs → `[would-update]` / `[updated]`, same as before.
- **No GitHub release, but the underlying git tag exists** → `[would-create]` / `[created]`. Body extracted from `CHANGELOG.md` the same way as the update path.
- No GitHub release and no matching git tag → `[error] tag '…' not found … and no matching git tag`. Same fail-fast as before for the genuine missing-tag case.

The `repos` subcommand is unchanged — it only walks existing GitHub releases.

Per-repo summary now also reports `created=N` alongside `updated=N`.
