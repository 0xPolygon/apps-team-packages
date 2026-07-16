---
'@polygonlabs/apps-team-lint': patch
'@polygonlabs/express': patch
'@polygonlabs/logger': patch
'@polygonlabs/openapi-registry': patch
'@polygonlabs/sync-github-releases': patch
'@polygonlabs/verror': patch
'@polygonlabs/viem-event-watcher': patch
'@polygonlabs/wallet-kit': patch
'@polygonlabs/zod-codecs': patch
'@polygonlabs/zod-to-openapi-heyapi': patch
---

Ship the LICENSE file inside the published npm package

The previous release added the Apache-2.0 license at the repo root and
declared it in package.json, but npm only auto-includes a LICENSE file
in the packed tarball when it lives in the same directory as the
package's own package.json. The license metadata was correct but the
actual license text was missing from the published package — this adds
it.
