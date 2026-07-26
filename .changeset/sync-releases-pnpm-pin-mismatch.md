---
'@polygonlabs/sync-github-releases': patch
---

Fixed a silent no-op when a target repo pins a different pnpm version than the
one running the tool. Package discovery shells out to `pnpm m ls` inside the
clone; if that repo's `packageManager` field names a version other than the
active pnpm, pnpm refuses to run at all. The failure was swallowed, so the run
reported `discovered 0 package(s)`, `skip: no changelog match` for every
release, and `errors=0` — indistinguishable from a repo that genuinely had
nothing to sync.

Enumeration now retries once with the package-manager version check waived. The
retry is a fallback rather than the default path, because the flag that waives
the check postdates pnpm 10 and passing it up front would break enumeration for
anyone on an older pnpm.

When enumeration still fails and the repo does have a root `package.json`, the
run now says so explicitly instead of reporting a clean pass. Repos with no root
`package.json` have nothing to enumerate and stay quiet as before.
