---
"@polygonlabs/logger": patch
---

Caller-supplied reserved keys in log merge objects are now preserved in a nested `_logger` field rather than being dropped or flat-renamed.

Previously, passing `timestamp` in a merge object renamed it to `callerTimestamp`, while `error_info` and `service` were silently dropped (with a warning). The flat rename created a second collision surface — `callerTimestamp` could itself collide — and the behaviour was inconsistent across keys.

Now all reserved keys (`timestamp`, `message`, `error_info`, `service`, `host`) are collected into a single `_logger: { ... }` object. This approach has one collision surface (`_logger` itself) instead of one per key, and the value is never lost. A single warn is emitted listing all affected keys.

If `_logger` is already present in the merge object as a plain object, the caller's values are merged into it rather than overwritten.
