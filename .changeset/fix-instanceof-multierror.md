---
"@polygonlabs/verror": patch
---

Fix `instanceof MultiError` failing across module boundaries in `errorForEach`

`@polygonlabs/verror` now exports `MULTIERROR_SYMBOL` (`Symbol.for('@polygonlabs/verror/is-multierror')`). MultiError and all subclasses carry this symbol as an instance property. `VError.errorForEach` uses `MULTIERROR_SYMBOL` to identify MultiError instances instead of `instanceof MultiError`, fixing silent incorrect behaviour when multiple copies of the package are loaded.
