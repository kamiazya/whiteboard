# Vendored lucide icon subset

Path data extracted from `lucide-react@1.28.0` (the version already used by
apps/web's UI), ISC License — see LICENSE in this directory.

Geometry rather than the package, because the consumers are on both sides
of this plugin's React line: `visual.symbol`'s schema enumerates these
names, the SVG renderer draws them with no React anywhere, and only the
badge picker is a React surface. lucide-react ships components, which the
renderer cannot use. The icons are 24x24 stroke-based outlines (fill none,
stroke-width 2, round caps/joins), emitted once per document as a
`<symbol>` def and referenced per node via `<use>` (canvas-render's
svg/backend.ts).

To add an icon: extract its `__iconNode` entry from the SAME lucide-react
version (`node_modules/lucide-react/dist/cjs/lucide-react.js`), normalize
attrs to numbers, drop `key`, and drop `ry` when it equals `rx`. Keep this
table alphabetical.
