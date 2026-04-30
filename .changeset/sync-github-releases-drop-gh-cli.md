---
'@polygonlabs/sync-github-releases': patch
---

Drop the `gh` CLI runtime dependency. The tool now clones target repos directly via `git`, passing `GH_TOKEN` through `git -c http.<base>.extraheader=AUTHORIZATION:...` rather than shelling out to `gh repo clone`. The token is set per-invocation, never written into `.git/config`.

Fixes the `ERROR: 'gh' was not found on PATH` failure for engineers who have `gh` aliased to a non-standard install location (where the alias is invisible to subprocesses Node spawns).

For consumers with `url.git@github.com:.insteadof=https://github.com/` in their git config, the HTTPS URL transparently rewrites to SSH and the extraheader is silently ignored — SSH key auth handles authentication. Both setups work without per-environment branching.
