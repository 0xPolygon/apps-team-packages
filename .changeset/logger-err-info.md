---
"@polygonlabs/logger": major
---

VError info is now emitted as `err.info` instead of the top-level `error_info` field

The `err` serializer now calls `VError.info()` to walk the full cause chain and merge info from every link. Previously, `error_info` was written as a separate top-level field and only captured the top-level error's info — cause chain context was silently dropped. The `error_info` field is removed entirely.

## Migration

Update any Datadog log queries, saved searches, monitors, or dashboards that reference `@error_info.*` to use `@err.info.*` instead.
