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

`visual.symbol` attaches to all three targets, and the three resolvers
(`resolveNodeSymbol` / `resolveCanvasSymbol` / `resolveDocumentSymbol`) are
thin wrappers over ONE reader. That matters because the surfaces differ: a
payload the schema refuses must mean "no symbol" on the minimap, the favicon
and a file row alike, and a second reader is how one surface comes to draw a
fallback the others do not. The document wrapper takes the
facets BUCKET rather than a document — this package cannot open stored
content, and every caller has already parsed the frontmatter it holds.
| `./render` (`src/render.ts`) | the whole rendering contribution: silhouettes, the readers that select them, text placement | React; anything that cannot run where a document is read |
| `./ui` (`src/ui.tsx`) | the settings declaration and the one hand-written editor | anything the renderer needs |

The default entry is react-free because it runs wherever a document is read —
Node, a worker, the browser — and `canvas-render` imports it. Keep that true:
a React import in `data.ts` or `icons/` is the one mistake this split exists to
prevent, and nothing mechanical catches it (the package legitimately lists
`react`, so the boundary scan cannot tell the halves apart).

## Dependency direction

```
facet-engine ← facet-ui ← plugin-visual ← canvas-render
        scene ←───────────────┘   └──────────┘
```

**There is no edge back into `canvas-render` at all.** `/render` names the
contract — `RenderContribution`, `ShapeContribution`, the scene-node union a
decoration returns, the edge-router types — and that contract is
`@kamiazya/whiteboard-scene`, a package below both this one and the renderer.

It used to come from the renderer itself, which made this a package CYCLE
held open by every import back being type-only: a property no manifest can
see, so it cost an entry in arch-lint's `KNOWN_PACKAGE_CYCLES` and a hand
guard, verified by mutation (a value import left all 102 arch-lint tests
green — the cycle check is intra-package and the direction check reads
`dependencies` only). With the contract extracted there is no cycle to hold
open, and `renderer-independence.test.ts` got STRICTER rather than
retiring: it pins that this package imports the renderer nowhere, type-only
or otherwise, which is what stops the cycle being reintroduced by a reader
who only knows the old rule.

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
  symbol editor)

Assertions about what `visual` DECLARES belong here, not in `facet-ui`. The
split is the test-level form of the dependency rule above.

## The generated emoji catalog

`src/emoji/catalog-data.ts` is GENERATED from Unicode's own `emoji-test.txt`
(`scripts/generate-emoji-catalog.mjs`) and committed, the way the vendored
lucide geometry is — a clone builds offline, and regenerating is a deliberate
step at a Unicode release. 1914 fully-qualified sequences in CLDR order,
skin-tone variants dropped (they are 2030 of 3944 and add no distinct meaning
to a symbol on a box; free entry still takes one).

Three things about it that a reader will otherwise re-decide:

- **Derived, never curated.** "Which two hundred emoji does this product
  like" has no defensible answer and goes stale each release. The published
  file already carries the character, its CLDR short name and its
  group/subgroup, which is exactly what a searchable palette needs, and it
  is published in the order a keyboard should show them in.
- **Reached by DYNAMIC import, from `data.ts`.** The facet definition is
  loaded wherever a document is read — the SVG renderer, the layout worker,
  `mcp-server` — and none of those draws a picker. A static import puts 69KB
  of strings in every one of those graphs; a dynamic one is the only thing a
  bundler treats as a separate chunk, which is why the engine's catalog
  contract is a `load()` returning a promise rather than a list.
- **This package owes the row check.** A listed picker option is parsed at
  `defineFacet` time and a catalog's rows cannot be. `src/emoji/
  catalog.test.ts` parses all of them against `visualSymbolFacetSchema`, and
  also pins that no row repeats an option the definition lists inline — the
  five hardcoded emoji this catalog replaced would otherwise have been drawn
  twice.

The subgroup travels as search KEYWORDS rather than a heading, and the
measurement says it earns the bytes: `transport` goes from 0 matches to 85,
`animal` 0 to 131, `sport` 3 to 156, `weather` 0 to 47.

**What it does NOT buy is the word on the category chip.** `travel` matched
nothing — the rocket is named "rocket" and filed under `transport-air`,
while the band a person can see it in is "Travel & Places". That is fixed in
the SEARCH rather than in the data (`facet-ui`'s `haystack` folds in the
band's label), because it is true of any catalog and costs no bytes here.
An earlier comment in this file claimed the subgroup was `travel-air` and
that "travel" therefore worked; it was written from memory and the data
refutes it.

**Japanese is a SEARCH index, not a label set** (`catalog-ja.ts`, CLDR
`release-48`, both `annotations/` and `annotationsDerived/`). What the picker
SHOWS is still the English short name, because the UI around it is English
and translating one string while leaving the rest is a half-localised panel;
what it MATCHES is a different question, and a person typing 星 is looking
for something this build has. Full coverage of all 1914, +118KB raw / ~34KB
gzipped, in the lazily-loaded chunk.

Two mechanics it needed, both found by measuring:

- **CLDR's base file strips U+FE0F from every `cp`** — it says so in its own
  header — and the derived file carries the sequences the base one lacks.
  So the generator unions both and falls back to a variation-selector-
  stripped lookup. `catalog.test.ts` guards coverage from both sides,
  because a half-covered index is a search that quietly finds less rather
  than an error anybody sees.
- **CLDR annotates emoji, not groups**, and its per-emoji keywords are
  specific (果物, 野菜). So the BAND carries Japanese of its own in
  `CATEGORIES` and its options inherit it: `食べ物` went from 7 of Food &
  Drink's 131 rows to all 131, `旅行` from 3 of 219 to 219.

The pinned CLDR tag is load-bearing: the annotation files carry `$Revision$`
where a version should be, so nothing in them says which CLDR they are, and
fetching `main` would make two regenerations differ with no record of why.

Not indexed: unconverted kana. CLDR's terms are kanji and katakana, so `ほし`
finds nothing while `星` finds 42 — acceptable because an IME user converts
before the term is a term, and a kana reading index is a different data set.

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
React: lucide-react ships components, and only the symbol picker can use them.
Follow the README's recipe when adding one, and keep the table alphabetical.

## The contributed edge ROUTER (`visual.path/v0`)

`edge-router.ts` is this plugin's `EdgeRouter`, registered as `routers` on
the render contribution and claimed by `readRouting` — the first real
customer of canvas-render's router seam, and the reason it exists.

**What it is FOR is the part to keep.** The renderer's three routings all
COMPUTE a path from two boxes and the obstacles between them, so none of
them can honour a bend somebody placed by hand, and JSON Canvas has no
waypoint to put one in. So the bends live in this plugin's own facet, and
this plugin draws them. A reader that does not know the plugin draws the
same edge with the built-in routing — which is exactly what makes a bend a
rendering preference rather than content.

Three decisions worth not re-litigating:

- **A separate facet from `visual.edges/v0`, not a field on it.** `edges`
  picks between routings; this one supplies the path. An edge carrying
  bends is not choosing a routing at all. It is also why the routing
  vocabulary was NOT widened — canvas-render's rule records what widening
  it cost.
- **The chosen SIDES are honoured, not re-derived from the first bend.**
  The anchor pass sees the whole edge set (crowding, fan-out lanes,
  crossings) and one edge's router cannot improve on it; an edge that
  wants a particular side says so through JSON Canvas's own
  `fromSide`/`toSide`, which that pass already reads. The router only
  computes an endpoint itself when NO side was resolved, and then it faces
  the neighbouring bend rather than a compiled-in default.
- **A payload the facet's own schema refuses draws the BUILT-IN route**,
  never half a path. Same degradation as an unknown shape id.

The derived editor answers `unsupported` for it — a list of points is
outside `deriveFacetForm`'s vocabulary — so the inspector shows the bends
read-only. That is the form layer's honest signal rather than a gap, and
the affordance a person uses is a DRAG on the canvas
(`apps/web`'s `EdgeBendHandles`), not a form.

One thing that surface measured belongs here, because it is a property of
where a bend LIVES rather than of the editor: the midpoint of a run is
already spoken for. `edgeLabelAnchor` draws an edge's label there and
double-pressing there opens its editor, so the add-a-bend ghosts sit at a
third and two thirds of each run instead. Placed at the midpoint they
swallowed the second press and failed every case in
`edge-label-edit.browser.test.tsx` while the bend tests stayed green — two
affordances aiming at the same pixel.


The end-to-end guard is `pnpm smoke:e2e`. Nothing in the type system
connects the facet `wb_facet_set` writes to the polyline the daemon emits,
so that step is what would catch the contribution being dropped from the
bundled plugin, or the bends being lost between the Loro edge bucket and
the layout.

## The theme facet and the bundled theme assets (ADR-0030)

- `visual.theme/v0` (canvas target, `data.ts`) names a registered theme
  ASSET by id — `visual.sketch`, `visual.neon`, or one another plugin
  registers. The payload carries no raw style; `assetRefs: { theme:
  'themes' }` makes `validateFacetWrite` refuse an id nobody registered,
  and the tier-2 segmented picker's `null` segment is the bundled look (an
  absent facet, never a stored `'default'`). `resolveCanvasTheme` answers
  the ID only; an id this deployment lacks degrades in the renderer.
- `themes.ts` holds the two assets as values of the engine's token
  contract, each with BOTH mode palettes (the surface follows the UI, never
  the theme). `themes.test.ts` holds every half to the bundled palettes'
  floors — strokes 3:1 against the surface, label text 4.5:1 against every
  fill it can sit on, syntax 4.5:1 — so a theme may change every colour and
  none of the guarantees. Sketch names `Yomogi` as its family — a Japanese
  handwriting face that also covers Latin, so a mixed-script label is one
  hand (user decision, 2026-09-09, from a thirteen-face specimen); the
  face is ADR-0011/0012's to provide, and a surface without it declares
  the bundled family and reports `font-missing`.
- `render.ts` hands the SAME asset objects to canvas-render as
  `themes`, beside `readTheme`, so the renderer's table and the registry
  cannot disagree about what `visual.sketch` is. Nothing in `ui.tsx`
  changes for a canvas facet: the canvas-settings vessel in apps/web is
  where a tier-2 canvas facet is rendered.
