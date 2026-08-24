---
paths:
  - "packages/plugin-visual/**"
---

# plugin-visual — the bundled `visual` plugin, as an ordinary plugin

## What this package is for

It is the worked example of ADR-0013's non-privileged principle. `visual` used
to live inside `facet-engine`, which made the engine import the one plugin it
was supposed to know nothing about — and made "how do I ship a plugin" a
question the codebase answered only in prose. Here it answers in structure: a
third-party plugin is this package with a different name.

Nothing about being bundled is load-bearing. The engine does not import this
package, and `bundledFacetRegistry` here is a convenience for the compositions
that want the shipped set, not a privileged registry.

## The two halves

| entry | holds | may not hold |
|---|---|---|
| `.` (`src/index.ts`) | schemas, the plugin definition, resolvers, the icon geometry `visual.symbol` enumerates | React, `node:*`, DOM globals |
| `./decorations` (`src/decorations.ts`) | what this plugin draws ON a node — today `visual.symbol`'s badge, with its size, margin and corner | React; anything that cannot run where a document is read |
| `./ui` (`src/ui.tsx`) | the settings declaration and the one hand-written editor | anything the renderer needs |

The default entry is react-free because it runs wherever a document is read —
Node, a worker, the browser — and `canvas-render` imports it. Keep that true:
a React import in `data.ts` or `icons/` is the one mistake this split exists to
prevent, and nothing mechanical catches it (the package legitimately lists
`react`, so the boundary scan cannot tell the halves apart).

## Dependency direction

```
facet-engine ← facet-ui ← plugin-visual ← canvas-render
                              └───(types only)───┘
```

**The edge back into `canvas-render` must stay type-only.** `/decorations`
returns scene nodes — `canvas-render`'s vocabulary — while `canvas-render`
imports those decorations as its default, so a value import back closes a
runtime cycle. `canvas-render` therefore sits in this package's
**devDependencies**, and `canvas-render-type-only.test.ts` enforces it:
nothing else does, verified by mutation (a value import left all 102 arch-lint
tests green — the cycle check is intra-package and the direction check reads
`dependencies` only).

Two edges are easy to get backwards:

- **`facet-ui` must never depend on this package.** It is the library every
  plugin builds on; depending on one plugin would close the loop and make the
  library untestable without it. Its tests use synthetic plugins for the same
  reason — a library test built on `visual` cannot tell a library defect from
  that plugin's own declaration.
- **`canvas-render` depends on this package, not the reverse.** The icon table
  is here because `visual.symbol`'s schema is what enumerates those names; the
  renderer draws from the same table. Putting the table in `canvas-render`
  while the picker needed it too was the package cycle that this arrangement
  resolves.

That `canvas-render` hard-codes one plugin at all is a known ceiling, recorded
against its entry in `tools/arch-lint/src/architecture-map.ts`: the upgrade is
injection, worth doing when a second plugin wants to change how a node is
drawn, not before.

## Tests

Two projects, because the halves run in different environments:

- `plugin-visual-node` — `src/**/*.test.ts` (schemas, resolvers, icon catalog)
- `plugin-visual-jsdom` — `src/**/*.test.tsx` (the settings declaration, the
  badge editor)

Assertions about what `visual` DECLARES belong here, not in `facet-ui`. The
split is the test-level form of the dependency rule above.

## Vendored icons

`src/icons/` carries lucide geometry with its LICENSE and provenance README,
and `VISUAL_ICONS` is that geometry plus the two things geometry is
meaningless without: the **coordinate space** it is drawn in and the **paint**
it is authored for. Both are declared HERE rather than defaulted in the
renderer, because they are properties of this icon set and not of drawing
icons in general — a contributed set in a different space, or one that fills
rather than strokes, is equally valid and says so the same way.

They were hard-coded in `canvas-render` until measured: a contributed 100x100
icon rendered into lucide's 24x24 box, and a fill-authored one rendered as
nothing at all.

Geometry rather than the `lucide-react` package because the renderer has no
React: lucide-react ships components, and only the badge picker can use them.
Follow the README's recipe when adding one, and keep the table alphabetical.
