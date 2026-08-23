# Vendored lucide icon subset

Path data extracted from `lucide-react@1.28.0` (the version already used by
apps/web's UI), ISC License — see LICENSE in this directory. Vendored
rather than depended on for the same reason as `vendor/budoux`: this
package's third-party surface is deliberately tiny (arch-lint allowlist),
and a subset of static geometry needs no runtime dependency. The icons are
24x24 stroke-based outlines (fill none, stroke-width 2, round caps/joins),
emitted once per document as a `<symbol>` def and referenced per node via
`<use>` (svg/backend.ts).

To add an icon: extract its `__iconNode` entry from the SAME lucide-react
version (`node_modules/lucide-react/dist/cjs/lucide-react.js`), normalize
attrs to numbers, drop `key`, and drop `ry` when it equals `rx`. Keep this
table alphabetical.
