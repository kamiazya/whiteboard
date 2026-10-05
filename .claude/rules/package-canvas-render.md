---
paths:
  - "packages/canvas-render/**"
---

# canvas-render — scene graph, pure layout, SVG backend, sceneDigest

The measurements, rejected alternatives and incident histories behind this file's
rules are in
[canvas-render-decisions](../../docs/contributing/architecture/canvas-render-decisions.md),
under the same decision numbers and headings. A passage lives in this file or in
that one, never both: a rule here that stops short of its numbers, or of why the
alternative was refused, continues there.

## What belongs here

`layout/` is split by the two JSON Canvas element kinds it serves, because
the code that serves them shares nothing:

- `layout/edges/` — the orthogonal edge router (side choice, cost model,
  Hanan-grid A*, crossings, jumps, rounding). Pure geometry over boxes; it
  has no idea what is drawn inside one.
- `layout/nodes/` — how a node's box is drawn and filled: outline shape,
  appearance resolution, the markdown body typesetter, truncation.
- `layout/` itself — the composer that draws on both (`spatial-canvas.ts`
  walks a canvas, `compose-node.ts` draws one node — text, frame, link and
  the dispatch — over the box primitives in `node-box.ts`, with a file node's
  representations in `compose-file-node.ts`), plus the kind-agnostic scene
  transforms it uses.

**The composer's own file is not the composer's only file.** Two
independently-featured OVERLAYS and the options vocabulary have their own
modules, and the direction between them is the point:

- `layout/layout-options.ts` — `SpatialLayoutOptions` (what a caller asks
  for), `ResolvedLayoutOptions` (the same thing after the entry point has
  settled geometry, contributions, theme and recursion path once), and
  `RegionChrome`. Nothing imports the composer to name them.
- `layout/comments.ts` — the annotation layer (ADR-0024/0025/0026): the
  pin, the region outline, the bubble.
- `layout/proposals.ts` — the proposal layer (ADR-0029 decision 1), which
  reuses the comment layer's constants deliberately.
- `layout/scene-extent.ts` — `contentExtent`, the one answer to "how far
  right and down does this laid-out block reach", which both overlays were
  computing with the same `Math.max(0, ...)` pair.

Both overlays take the body typesetter as a SEAM (`BodyLayoutSeam`) rather
than importing it. The markdown options a bubble is laid out with are built
by the composer, which recurses back into `layoutSpatialCanvas` for an
embedded canvas — importing it would close a cycle, and passing it keeps
the dependency pointing one way. `compose-node.ts` takes that entry the same
way, as `ResolvedLayoutOptions.layoutNestedCanvas`.

The split was made because the two clusters were measured to have ZERO
production imports between each other while sitting in one flat directory,
so the directory gave a reader no signal which of two unrelated engines a
file belonged to. `layout/layer-boundary.test.ts` is what keeps that true:
the clusters may not import each other, and may not reach up to the
composer. Tests are exempt — an edge-router test that builds its fixture by
composing a whole scene is doing setup, not depending on the composer.

**The scene-node union stays closed** — every consumer is in this repo, and
an open union would buy dispatch flexibility nobody has asked for at the
cost of the exhaustiveness checking the SVG backend relies on. That has not
changed and should not.

Shapes are now a TABLE keyed by namespaced id (`ShapeTable`,
`layout/nodes/node-outline.ts`), merged over the built-ins by both
`SpatialLayoutOptions.shapes` and `SvgDocumentOptions.shapes`, exactly as
`icons` already worked.

It cost less than the old paragraph implies because three of the four outline
functions never knew a shape's name: `outlineContains` switches on the
returned `NodeOutline`'s kind and `outlineEntryPoint` bisects against that.
Only the geometry and the content box are per-shape — which is the whole of
`ShapeContribution`.

**Decorations are the second contribution point, and the cheap one.** A
`NodeDecoration` is handed a node plus its CONTENT box and the resolved label
appearance, and returns scene nodes drawn after the node's own content. They
COMPOSE — several plugins marking one node is a stack, not a competition — so
order answers by contribution order and no conflict rule is needed, unlike a
silhouette. `visual.symbol`'s badge is one of these and now lives in
`plugin-visual`, taking its size, margin and corner with it; this package no
longer knows what a badge is.

**An icon contribution carries its coordinate space and paint**, not geometry
alone (`IconContribution`, `svg/backend.ts`). Geometry means nothing without
the box it is drawn in and the convention it is authored for; holding both as
constants here made a contributed icon in any other space render wrong-sized
and a fill-authored one render invisible. The bundled set declares its own, so
the renderer's fallback (24x24, stroke-only) is only for a table that says
neither.

The default is the bundled plugin's set, NOT an opt-in, for the lowlight
reason recorded in `architecture-map.md`: a resolution step four call sites
have to remember is one a call site forgets, and the surface that forgets does
not fall back to the same picture — it silently draws less.

Ids are COMPOSED from the declaring facet's key plus its bare payload kind,
never stored whole, so nothing migrates and a plugin cannot name another
plugin's geometry. The remaining asymmetry is recorded at
`resolveNodeOutlines`: the bundled facet is read through `resolveNodeShape`
(compat chain + schema) while a caller-declared one is read raw and gated by
the table alone.

- Plain-TS scene graph types (`scene-graph.ts`): resolved bounding boxes,
  shape kind, text runs, list/heading/table structure, the SVG-fragment
  (math/diagram) seam node, resolved edges.
- `layout/edges/edge-geometry.ts`: the geometry VOCABULARY the edge layer is
  written in — rectangles, points, sides, polylines — with no opinion about
  routing or side choice. It exists because that vocabulary had no home:
  `spatial-edges.ts` held the side-choice search, the router and these
  primitives in one file, and the search reached into the router's half for
  `rectOf`/`centerOf`/`pathLength`/`tangentCoordinate` only because that is
  where the words lived. Judgement stays out: which side to prefer and what
  makes one route better are `edge-rules.ts` and `spatial-edges.ts`. Keeping
  this layer opinion-free is what lets both share it without either
  importing the other — and it was the piece the router/search split
  needed first.
  So `layout/edges/` is now `edge-sides.ts` (which side an
  edge leaves from and arrives at, and the first guess), `edge-anchors.ts`
  (where on that side, given every edge sharing it), `edge-router.ts`
  (`routeEdge`: the path between two placed anchors) and `spatial-edges.ts`
  (the side-choice search, `assignEdgeAnchors`), with the dependency
  pointing one way and `boundingBoxOf` / `rectAtEnd` joining the geometry
  vocabulary since both halves read them.
- Pure layout functions: spatial-canvas edge routing (`layout/edges/edge-router.ts`
  under `layout/edges/spatial-edges.ts`'s side-choice search) and mdast block
  layout (`layout/nodes/mdast-blocks.ts`) — the single mdast -> scene-graph
  render path shared by preview / spatial text node / export.
- `layoutSpatialCanvas` (`layout/spatial-canvas.ts`): the single
  `SpatialCanvas` -> `Scene` builder shared by every consumer (Node export,
  the browser viewer) — see the resolved decision below.
- `translateScene` (`layout/translate-scene.ts`): the pure scene -> scene
  translation used to place a node's laid-out content at its absolute
  position, alongside the renderers whose x-transform-boundary convention
  it must agree with (see decision #5 and `svg/backend.ts`).
- `scaleScene` (`layout/scale-scene.ts`): the multiplicative sibling of
  `translateScene` — uniform scaling about the origin for composing a
  resolved child canvas into a parent node's box (scale-then-translate).
  Uniform scaling commutes with the x-transform-boundary representation,
  so unlike translation it needs no wrapper special-casing. Size-bearing
  paint fields (fontSize/strokeWidth/radius/baseline) scale with the
  geometry; `svgFragment` payloads and backend-derived arrowhead sizing
  deliberately do not (documented, test-pinned). Total: factor 1 is the
  identity, non-finite/non-positive factors return the input unchanged.
- The injected text-measurement seam (`measure.ts`: `FontDescriptor`,
  `TextMetrics`, `MeasureText`) — layout never imports a font or measurer.
- The SVG backend (`svg/backend.ts` + `svg/format.ts`): scene -> SVG string,
  one implementation shared by Node/browser/Workers. `svg/shapes.ts` draws a
  node's silhouette and an edge's line (crisp or pencilled, with the glow
  either takes); `svg/paint.ts` holds the presence-only paint helpers.
- `sceneDigest` (`scene-digest.ts`): the AI-facing spatial digest, the one
  Zod-schematized output of this package. It reports one entry per
  ADDRESSABLE node — the chrome shapes carrying a document `id` — because
  the reader's only way to act on what it sees is a tool that takes a node
  id. Content laid out inside a node (its text runs, a facet card's rows)
  carries a bbox too but is deliberately excluded: reporting it made a
  three-node canvas answer with six entries, each "contained in" another,
  and none of the extra three could be acted on. A scene with no identified
  shape at all (hand-built, a fragment) keeps the older behaviour of taking
  every bbox-carrying node named by position — there is nothing better to
  name them by, and the alternative is answering with nothing.

## What does NOT belong here

- MathJax (or any math typesetting engine) invocation — composition roots
  own that; this package only defines the SVG-fragment node type and the
  seam for a composition root to inject an already-rendered fragment.
- The theme TOKEN CONTRACT itself — that is facet-engine's
  (`themeTokensSchema`, ADR-0030 decision 3); this package maps tokens onto
  its palette (`theme/theme-asset.ts`) and never re-declares them.
- A Canvas-API rendering backend, PNG/resvg rasterization, opentype.js /
  font loading — those are composition-root concerns that supply the
  `measure` callback, not something this package imports.
- Any DOM projection / a11y parallel-DOM implementation — this package's
  job is to retain the semantic provenance (heading level, list structure,
  link targets) that a future a11y layer would need, not to build that
  layer itself.

## Dependency rules

- Runtime dependencies: `@kamiazya/whiteboard-model` (spatial nodes/
  edges + the `./mdast` subset), `@kamiazya/whiteboard-codec` (the DEFAULT
  `parseBody`; every consumer already bundled it to pass that same function
  in), `@kamiazya/whiteboard-scene` (the scene vocabulary),
  `@kamiazya/whiteboard-plugin-visual` (the default render contribution),
  `@kamiazya/whiteboard-facet-engine` (the theme token contract, zod-only),
  `css-line-break` (UAX #14 break opportunities), `lowlight` + `highlight.js`
  (the default code tokeniser and its grammars) and `zod` (via `catalog:`),
  for `sceneDigestSchema` only.
- Forbidden imports: `node:*`, DOM globals (`document`/`window`/`navigator`/
  `HTMLElement`), `inversify`. Enforced by `src/import-guard.test.ts`, which
  captures every production source at build time via `import.meta.glob`
  (`?raw`) rather than reading files at runtime, so the guard itself never
  imports a `node:*` API.

## Resolved design decisions (do not re-litigate without a new gate)

1. **Scene graph stays plain TS, not Zod.** It never crosses a process
   boundary — only the SVG string and `sceneDigest` JSON leave this
   package — so per YAGNI + zod-schema-discipline it needs no runtime
   schema. `sceneDigestSchema` is the sole Zod surface here.
2. **Canonical SVG serialization** (`svg/format.ts`): fixed per-element
   attribute declaration order, `&`/`<`/`>` escaped in text, plus `"`/`'`
   escaped in attribute values, a single root `xmlns`, and one number
   formatter (`formatCoord`: fixed decimal precision, `-0` normalized to
   `0`, non-finite rejected — a layout bug, not a serializer concern).
   This is what makes the same scene produce byte-identical SVG on Node
   and in a real browser.
3. **`FontDescriptor`/`TextMetrics` shape** (`measure.ts`): all `TextMetrics`
   fields are CSS px already scaled to `FontDescriptor.sizePx`, never raw
   font design units. `fallbackChain` is declared but resolved by the
   composition-root measurer (opentype.js on Node/Workers, Canvas
   `measureText` in the browser). Layout never passes a string containing
   a newline to `measure`, and clamps any non-finite `advanceWidth` to `0`
   (`clampAdvance`) before it reaches geometry.
   `constantRatioMeasureText` — the measurer of last resort — lives here
   too, beside the contract it satisfies. Three composition roots had grown
   their own copy (server-core cannot load a font itself and gets one
   injected via `ServerDeps.measure`, mcp-server needs one when the
   vendored asset is missing, canvas-viewer when the realm has no Canvas 2D
   context) with three DIFFERENT constant sets, so the same canvas measured
   differently depending on which degraded path produced it. The ratios are
   arbitrary; the point is that they are arbitrary in one place. It matches
   no real font by construction — a scene laid out with it is degraded,
   never byte-reproducible against a measured one.
   It is nonetheless SCRIPT-AWARE, via `isFullWidthCodePoint`, and that is
   not a refinement of the estimate but a correction of the model: charging
   every character one ratio is not an approximation of Japanese, it is
   wrong.
   A real measurer reads the advance from the font and has no use for the
   predicate — with ONE exception it must handle: a font that lacks the
   glyph. `opentype.js` answers a missing glyph with the `.notdef` advance
   (a flat ~0.44 em in the vendored Roboto), which is not a measurement and
   is worse than the estimate. A real measurer therefore falls back to the
   estimator PER CODE POINT for anything the face does not carry, detected
   by glyph index rather than by comparing advances.
4. **The embed contract.** Root depth is `0`; a 4th nesting level is the cap
   hit (depth cap `3`). Cycle detection is PATH-LOCAL — a re-visit on the
   *current* recursion path is a placeholder, but the same doc reached
   again via a disjoint path renders normally. A missing or unresolvable
   target degrades to the same placeholder mechanism. Layout is total: it
   never throws and never infinite-loops, on any graph including dense
   cyclic ones. It was first stated over a `ResolvedDocBundle` in a
   module of its own whose only caller was its own property test; that
   module (embed-recursion) is deleted, and the
   contract lives where the content is laid out: `compose-node.ts` for a
   file node's canvas and `mdast-blocks.ts` for a body's embeds, each
   pinning the cap and the path-local cycle rule:
   `MdastLayoutOptions.resolveEmbed?: (canvasId) => { title?, root:
   MdastRoot } | undefined` (same injected-resolver class as `renderMath` /
   `resolveReference`). A paragraph whose SOLE child is an `embed` node lays
   the resolved body out inline under an `embedResolved` node whose
   children stay ABSOLUTE (no SVG transform — the listItem/tableCell
   transform-boundary set is untouched); an embed mixed into prose stays a
   link run, labeled with `title` when known. Depth cap and path-local
   cycle semantics mirror this decision exactly, and a missing/throwing
   resolver degrades to an `embedPlaceholder('unresolvable')`. Both guards
   are pinned by a property over dense random embed graphs
   (`mdast-blocks.properties.test.ts`), each mutation-checked separately —
   the cap alone also bounds nesting, so a depth assertion by itself would
   let the cycle guard rot.
5. **Document envelope** (`sceneBounds` in `scene-bounds.ts`,
   `SvgDocumentOptions` in `svg/backend.ts`): `renderSceneToSvg(scene)`
   with no options, or an options object with every field `undefined`,
   emits the legacy bodyless-root form (`<svg xmlns="...">...</svg>`)
   byte-for-byte — this is the frozen default path guarded by
   `DETERMINISM_GOLDEN_SVG`. Setting ANY of `width`/`height`/`viewBox`/
   `padding`/`background` activates the full envelope (never a partial
   one): root attributes in the fixed order `xmlns width height viewBox`,
   derived as `viewBox = options.viewBox ?? expand(sceneBounds(scene),
   padding)` and `width/height = options.width/height ?? viewBox.w/h`. A
   `background` renders a `role="presentation"` `<rect>` covering the
   viewBox as the FIRST child, ahead of every scene node — this is
   document chrome, not a per-node visual attribute, and is the one
   documented exemption from this package's "no visual attributes on
   scene nodes" rule (no `<style>` block or per-node fill/stroke/font is
   ever added). `sceneBounds` is total and never returns `NaN`/`Infinity`/
   a zero-area box: an empty scene, or a scene whose bboxes/edge points
   are all-zero-size or all non-finite, degrades to the documented
   fallback `{ x: 0, y: 0, w: 1, h: 1 }`; a collapsed axis on a
   non-empty scene is clamped to `MIN_SCENE_EXTENT_PX = 1` while `x`/`y`
   are preserved. `sceneBounds` walks the WHOLE scene tree (every depth,
   not just top-level) with an explicit stack (no recursion, so no
   stack-overflow path on deep embed chains), including edge polyline
   points; a bbox/point with any non-finite field is skipped rather than
   clamped. **The walk carries an accumulated x-offset**, because the scene
   graph is NOT uniformly absolute: `renderListItem` and `renderTableCell`
   are the only renderers that emit a `transform`, each translating its
   subtree by its own `bbox.x` on the x axis, so a list item's children and
   a table cell's runs are stored wrapper-RELATIVE and nested wrappers
   compose. Bounds taken without re-applying those offsets sit short of what
   is actually drawn and the derived `viewBox` clips the overflow. A third
   translating renderer must therefore teach `subtreeOffsetX` about itself;
   a tripwire test in `scene-bounds.test.ts` fails if that set ever changes.
   Note the top-level-only containment property cannot see this class of bug.
6. **The `shape` node and optional resolved `Appearance`** (`scene-graph.ts`):
   `ShapeSceneNode` (`kind: 'shape'`, `bbox`, optional `radius`) is the box
   chrome of a spatial canvas node — a rect with an optional uniform corner
   radius. Deliberately minimal: a rect covers every spatial node kind
   today, so ellipse/polygon/path are NOT added speculatively. `Appearance`
   (`fill?`, `stroke?`, `strokeWidth?`, `fontFamily?`, `fontSize?`, all
   optional) is ONE named type reused as an optional `appearance?` field on
   exactly three variants — `ShapeSceneNode`, `TextRunNode`,
   `ResolvedEdgeNode` — never a per-kind ad-hoc field. Appearance is
   **assigned, not invented**: this package's own layout functions never
   choose a color, font, or stroke width — that is a composition-root
   concern today and the exact seam the later theme layer fills in (a pure
   scene-graph -> scene-graph transform). The SVG backend emits presence-only
   attributes in the FIXED order `fill stroke stroke-width font-family
   font-size`, appended after geometry; an absent or unusable field is
   OMITTED, never defaulted, which is what keeps a scene built without
   appearance byte-identical to the pre-existing output (the additivity
   guarantee both `DETERMINISM_GOLDEN_SVG` and `DETERMINISM_GOLDEN_DOCUMENT_SVG`
   depend on — a new, separate golden covers shape/appearance instead of
   regenerating those two).
   `shape` emits no `transform`, so it needs no entry in
   `subtreeOffsetX` and the two-renderer tripwire above is unaffected.

7. **`layoutSpatialCanvas` is the single SpatialCanvas -> Scene builder**
   (`layout/spatial-canvas.ts`), replacing two independently-grown builders
   in mcp-server and canvas-viewer. A markdown parser is an injection seam,
   the same class as `measure`/`renderMath`: this package never depends on
   codec, so `parseBody: (text: string) => MdastRoot` is supplied by
   the caller (both current consumers pass codec's
   `parseMarkdownBody`). Appearance is likewise injected via a
   `SpatialAppearanceResolver` (`theme/spatial-appearance.ts`) — a set of
   FUNCTIONS (`resolveNode`, `resolveEdge`, `resolveLabel`), not a static
   per-kind record, because appearance keys off both `node.type` and an
   authored `node.color`/`x-whiteboard` hint. (Geometry constants —
   `paddingPx`/`labelFontSizePx`/`minContentWidthPx` — used to live on this
   same interface; decision #8 below moved them out into
   `SpatialLayoutOptions.geometry`, since a surface being free to pick its
   own geometry is exactly the bug decision #8 exists to prevent.) No
   default resolver is exported — appearance stays assigned, not invented,
   per decision #6. Emission order is
   DOCUMENT order (nodes in array order, shape then content per node, then
   all edges), never sorted by position: z-order is authored, not derived,
   so a position sort would silently reorder authored z-order. Export
   reproducibility does not need a sort to hold — document order is
   already a total function of a deterministic canvas. Because this
   package has no logger (a shared layer has no ambient platform API), a
   degradation (a body-parse failure, an unrecognized node kind) is
   reported only through an optional `onDegrade` callback; mcp-server wires
   it to `getLogger`, canvas-viewer omits it and degrades silently by
   choice — an omitted callback must never change the returned `Scene`, only
   whether the caller is told. `translateScene` (`layout/translate-scene.ts`)
   moved here verbatim from mcp-server's former `scene-transform.ts`: it
   encodes the same x-transform-boundary rule as `sceneBounds`'s
   `subtreeOffsetX` (decision #5), so both must keep agreeing on which
   renderers (`listItem`, `tableCell`) emit their own SVG `transform` — the
   tripwire test asserting that exact set now lives in
   `translate-scene.test.ts` alongside the function it guards.

8. **The theme layer** (`theme/spatial-geometry.ts`, `theme/spatial-palette.ts`,
   `theme/spatial-theme.ts`, `theme/font-family.ts`): ONE `SpatialAppearanceResolver`
   producer, `createSpatialTheme({ mode })`, replacing three independently-grown
   per-surface resolvers (apps/web's `editor-appearance.ts`, canvas-viewer's
   deleted `viewer-appearance.ts`, mcp-server's deleted
   `spatial-scene-appearance.ts`). This was triggered by a real defect: the
   three resolvers disagreed on `minContentWidthPx`/`labelFontSizePx`
   (GEOMETRY, not appearance), so the same canvas laid out for the editor and
   for export did not agree on wrapped-line counts or content width.
   `SpatialAppearanceResolver` (decision #7) is narrowed to drop those three
   fields entirely — a resolver can no longer smuggle in its own geometry.
   `SpatialLayoutOptions.geometry` (optional, defaulting to the shared
   `SPATIAL_THEME_GEOMETRY` constant) is now the ONLY place geometry can be
   overridden, so a divergence is a reviewable one-line diff at a call site
   rather than a silent per-file constant. `spatial-geometry-parity.test.ts`
   is the executable guard: three resolvers that disagree on nothing but
   color must still produce identical geometry (bbox/baseline/path,
   recursively) from the same canvas.
   Dark mode is a PARAMETER of this one theme
   (`createSpatialTheme({ mode: 'light' | 'dark' })`), not a second
   appearance authority layered on top — a scene->scene dark transform would
   still need the same per-type semantic knowledge this theme already has,
   so it would be strictly more machinery for the same result while
   reintroducing exactly the multi-producer divergence this decision exists
   to delete. The editor's dark palette (contrast-tested against the WCAG
   1.4.11/1.4.3 floors) is the shared theme's dark palette; viewer and export
   both pin `mode: 'light'` at their call sites, preserving the invariant
   that a user's UI theme can never change exported bytes. `headless-renderer`'s
   `theme: 'dark'` now builds the scene with `createSpatialTheme({ mode:
   'dark' })` and sets `SvgDocumentOptions.textFill` (an inheritable root
   `fill` — the document-level analogue of the editor host's inherited CSS
   fill) so body runs stay legible on the dark background. `theme` is an
   explicit per-request argument; the invariant that ambient UI theme never
   changes exported bytes still holds, and light exports are byte-identical
   to before.
   `theme/font-family.ts`'s
   `SPATIAL_THEME_FONT_FAMILY` ('Roboto') is now what every
   `resolveLabel()` declares. `VIEWER_FONT_FAMILY` (canvas-viewer) and
   `EXPORT_FONT_FAMILY` (mcp-server) each carry their own `'Roboto'`
   literal: canvas-viewer's `font.ts` is read by `vite.widget.config.ts`
   under Node's native loader, which cannot resolve this package's TS-source
   exports. The duplication is held equal by
   `tools/arch-lint/src/font-family-literals-agree.test.ts`.

9. **`ImageSceneNode` and the resolved `image`** (J5b): the scene
   graph's one raster/vector image node — `bbox` is the FRAME (aspect always
   preserved via `preserveAspectRatio="xMidYMid meet"`), `href` is emitted
   verbatim (data: URI in exports, blob:/app URL live), `alt` renders as a
   `<title>` child and its absence marks the image presentation. A
   resolution's `image` is checked BEFORE its `canvas` and is not LOD-gated
   (a scaled-down image is still a meaningful thumbnail); any failure keeps
   the card. Image nodes are bbox-only leaves for
   sceneBounds/translate/scale.

10. **The render-style seam** (rendering-foundation initiative, human
    decisions 2026-08-12). Recorded BEFORE any style ships so the sketchy/
    hand-drawn style and facet-driven cards land on settled ground instead
    of re-litigating decisions #6-#8.
    - **Style is a DOCUMENT property, not a personal preference.** It rides
      the canvas (the `x-whiteboard`/`view`-facet lineage), so every
      collaborator and every output sees the same look. It threads as an
      explicit per-render-call argument (`SpatialLayoutOptions` → backend),
      never ambient — the same editor-ambient-but-export-explicit shape as
      theme mode (#8). Export, the MCP render tool, and the viewer widget
      default to the clean style; a styled render is opt-in per call: the
      MCP/widget consumer is often an AI agent, for whom jittered
      multi-stroke geometry is parsing noise it must never pay unasked.
    - **Geometry variance lives behind ONE shared pure decomposition
      function per primitive** (rect → stroke set, edge path → stroke set)
      in `layout/`, consumed by BOTH the SVG backend and every hit/
      highlight/preview consumer — the `edge-rounding.ts` drawn-vs-hit
      precedent, generalized. This is NOT the scene→scene transform #8
      rejected: #8's case (dark mode) was paint-only and a pass would have
      duplicated per-type knowledge; a style is geometry-bearing, and the
      answer is shared decomposition at the consumption points, keeping one
      producer per geometry.
    - **Ink is decoration; semantics stay authoritative.** `sceneBounds`,
      hit-testing, `sceneDigest`, translate/scale keep reading the SEMANTIC
      geometry (bbox / routed path). A style's painted deviation from it
      must be bounded by a declared constant (the jump-arc/arrowhead
      class), and that bound is part of the style's contract.
    - **Style randomness is seeded, id-keyed, and pure** (the `layout/seed`
      primitive): derived from stable node identity, never ambient RNG;
      invariant under translate/scale composition; unaffected by edits to
      unrelated nodes. A canvas renders byte-identically twice, styled or
      not.
    - **Layout-quality feedback lands as NAMED RULES of exactly two
      kinds.** Preference rules affect candidate ordering and tie-breaks
      only and are never traded against penalties; penalty rules are
      cost-tuple terms with a declared lexicographic tier. New routing
      feedback = one named rule + its own test, not a new branch in an
      existing function. `layout/edges/edge-rules.ts` implements the PREFERENCE
      half: `SIDE_PREFERENCE_RULES` names zero-bend-facing-first,
      dominant-axis-first, l-pair-crowding-tie-break, u-hook-when-degenerate,
      gap-valid-opposing-before-invalid, u-hook-span-exposed-first, and
      incumbent-wins-ties; `composeSidePairs` is the composition
      `rankedSidePairs` (`layout/edges/edge-sides.ts`) wraps, and
      `shouldAdoptCandidate` is the incumbent-wins-ties predicate
      `optimizeSideChoices` consults. `u-hook-span-exposed-first` demotes a
      same-side U-hook candidate whose DEPARTURE side border runs through
      the target's strict interior (group frames excluded via
      `fullyContains`) behind one that does not — this is what makes the
      optimizer's ALREADY-CORRECT scoring of a clean same-side route
      reachable in one improving hop instead of several: the defect was in
      candidate ORDER, not the search budget, so `CROSSING_OPT_MAX_PASSES`
      stays 2. The PENALTY half is `PENALTY_RULES`: overlap-and-intrusion
      (tier 0, collinear overlap plus self-retrace/body-intrusion),
      illegibility (tier 1), crossings (tier 2), endpoint-body-ink (tier 3,
      self-only — a routed segment STRICTLY BETWEEN a rect's two borders,
      priced against the edge's OWN endpoint rects since `foreignBodies`
      deliberately excludes them for the tunnel check), border-tracing
      (tier 4, self-only — the border complement: a segment collinear with
      AND overlapping a node's own border, `nodeBorders` including the
      path's own endpoint rects unlike `foreignBodies`), path-reversal
      (tier 5) and realized-bends (tier 6, self-only and deliberately
      last).
      `pairScore`/`selfPenalty`
      (`spatial-edges.ts`) compose over the list, and every cost-tuple
      helper (`ConfigCost` shape, `addCost`, `lessCost`,
      `hasRepairableProblem`) derives from the declared tiers, so a new
      penalty rule is one list entry, never a new slot threaded by hand.
    - **The side-choice search runs TWICE, and only the second run sees the
      geometry that gets drawn.** `optimizeSideChoices` scores its trials
      from unaligned anchors, because varying alignment *within* a run moves
      trial costs mid-search and shifts side-choice equilibria (a bystander
      edge was observed re-siding onto a worse face). The price is that a
      configuration can score clean in trial space and acquire real defects
      the instant the final pass aligns it — a reported canvas settled on a
      route scoring `[0,0,0,0,267,3,5]` aligned, while a candidate already
      in its own ranked list scored `[0,0,0,0,0,1,3]`; the search adopted
      neither number because it saw neither. So `assignEdgeAnchors` hands
      the settled configuration back through the SAME search once more with
      `align: true`. Alignment is constant within each run, so neither can
      oscillate — the rejected variant was alignment that varied *during* a
      run, which is a different thing. The second run is a REPAIR pass, so
      it always takes the worst-offender edge list at every canvas size
      (the unaligned run keeps its exact full-iteration behaviour at or
      under `FULL_OPT_MAX_EDGES`): an edge with nothing wrong with it has
      nothing for the pass to fix.
    - **Past the optimizer's edge gate the search runs over spatial REGIONS,
      not over nothing.**
      `optimizeAcrossRegions` groups edges along a Morton curve
      through their midpoints, chunks them into even regions of at most the
      gate, and runs the ordinary two-run search per region. It works because
      interaction is LOCAL: 4-5% of edge pairs survive a bounding-box test on
      the clustered bench cases (55% on the deliberately pathological stride
      canvas). What it gives up, stated plainly: a crossing between edges in
      two different regions is never priced.
      Nothing at or under the gate changes, by
      construction (one region, same two runs, same seed).
      Region size is `CROSSING_OPT_MAX_EDGES` itself rather than a second
      knob, deliberately.
      **The live-drag path keeps the hard gate.** Several hundred ms is worth
      paying once on a committed change and never on a frame someone is
      dragging through, so a canvas past the gate drags exactly as fast as
      before and picks up its regional repair on drop.
    - **Batch (Jacobi) side-choice evaluation is MEASURED AND DEFERRED, not
      untried.** The search adopts one improvement at a time and re-bases
      before the next edge (Gauss-Seidel), which is inherently sequential —
      the reason a GPU cannot help it, and the real prerequisite behind any
      WebGPU/SIMD plan. (Float determinism is NOT that blocker: integer or
      fixed-point arithmetic is bit-exact on a GPU, and this package's cost
      model is already integer-quantized by `COST_QUANTUM`.)
      Do not re-propose GPU or batch search for SPEED; what batch still
      offers is QUALITY on large canvases (345-edge clustered: violations
      183 -> 138, interior ink -22%) at 4x the time, which is a separate
      trade. The speed work goes
      into the CPU-side costs the profile named.
      One cost off that profile is taken: the routed-path cache is owned by
      the REGION rather than by each `optimizeSideChoices`, so it spans a
      region's unaligned and aligned runs. That pairing is where the repeats
      are — 1021 of 1900 routings on the clustered canvas repeat a key the
      other run of their own region already saw, against 567 caught by the
      per-search caches. Worth 15-19% there in six of six interleaved
      comparisons, within noise on the grid canvas. Sound because `nodes`,
      `style` and an edge's obstacle list are fixed across those two runs,
      leaving the anchor pair as the only variable — and `routeCacheKey`
      covers it field by field, pinned one case per field, because a field
      the key misses is a wrong path rather than a slow one.
      **`routeOnGrid` searches with A*, and finding that out took refuting the
      obvious answer first.**
      A Manhattan heuristic makes it A*: admissible (a step costs
      its own Manhattan length plus a non-negative bend charge) and consistent
      (the same inequality edge by edge), so the first pop of the goal stays
      optimal.
      It is NOT free, and the price is a kind worth recognising. A* is fast
      precisely because it does not expand the states a blind search does, so
      among EQUAL-cost shortest paths it settles on a different member.
      That cost cannot be bought back inside the router, and the reason is
      structural rather than a tuning failure: `routeOnGrid` is handed every
      obstacle including the edge's own endpoints and avoids all their
      interiors, so its path can never BE a violation — the difference arrives
      through the side-choice search, which a per-edge routing cost cannot see.
      **The per-trial pair loop was measured next, and REJECTED after three
      variants.**
      Replacing the walk with an x-sorted index over path bounds, plus a
      `neighbours` adjacency so pairs that scored non-zero BEFORE can still be
      subtracted, is the obvious fix and does not pay.
      **What DID pay was pruning the obstacle set per routing call.**
      The bound is where the care is, and the first version got it wrong.
      Elbows live inside `bbox(start, exit, entry, end)`, which is exact for
      the clearance tests and for `crossedBy` — that only ever tests elbow
      segments. But a DETOUR waypoint is placed `OBSTACLE_CLEARANCE_PX`
      OUTSIDE the region, so a box stopping at the region dropped obstacles a
      detour still ran into. The routing scoreboard caught it, as moved pins
      rather than as a crash — which is a long way from naming the cause. So
      the bound is pinned rather than remembered: `DETOUR_REACH_PX` is
      exported beside `detourCandidates` and
      `detour-reach.properties.test.ts` asserts every waypoint stays inside
      it, mutation-checked by zeroing the constant (the bug as shipped) and by
      moving a waypoint one pixel further out. A prune whose bound is too
      small does not throw; it quietly reroutes.
      The guard for all of this is `grid-route.optimality.properties.test.ts`,
      an independent-oracle property: a plain Dijkstra written in the test from
      the definition, asserting equal COST (never equal path — equal-cost
      routes are the norm on a lattice). It exists because an inadmissible
      heuristic fails silently: it returns a merely-good path, and every debt
      metric the scoreboard pins stays put because a slightly-long detour still
      avoids every body. Mutation-checked twice, and the second mutation is not
      hypothetical — accumulating the successor's `g` from the popped `f` was
      written during this change and caught by reading the push site, not by a
      test. The property catches it now.
    - **Facet-driven rendering rides the injected-resolver pattern.**
      Shipped as the `facets` field of `ResolvedReference`
      (`layout/compose-node.ts`) — synchronous, optional, caller-supplied,
      total (a throw or `undefined` degrades to the plain chrome+label
      rendering rather than aborting layout).
      `FacetCardData` (`{ title?: string; rows: ReadonlyArray<{ label:
      string; value: string }> }`) is plain TS, not Zod — it never crosses a
      process boundary; the caller maps its own facet data
      (`coreFacetsSchema` and friends) into it in-process, and this package
      learns nothing about what a facet MEANS. `composeFileFacets` is
      checked LAST in the file-node pre-pass — after `composeFileImage`,
      `composeFileEmbed` and `composeFileMarkdown` — so a resolved image,
      canvas embed or markdown body always outranks a facet card, and the
      card in turn always outranks the plain label it replaces. Card text goes through `typesetMdastBlocks`
      (`heading`+`paragraph` blocks only, never `list`/`table`, to stay out
      of the `subtreeOffsetX` transform-boundary class); content that
      overflows the node's padded box is truncated at whole-block
      granularity with no "more" affordance (ponytail: that needs a
      focusable DOM-overlay/keyboard treatment this pure-geometry package
      cannot own — upgrade path is an editor-side overlay in a later
      slice). `apps/web` supplies the card (`toFacetCard` in
      `use-document-file-seams.ts`); export still resolves nothing by default,
      so it stays a pure function of the canvas snapshot, exactly parallel
      to the style opt-in above.

11. **ONE reference seam, not one per content kind.** `SpatialLayoutOptions`
    carries a single `resolveReference?: (ref: string) => ResolvedReference
    | undefined`, where `ResolvedReference` is a record of independent
    optional fields — `label`, `missing`, `image`, `canvas`, `markdown`,
    `facets` — ranked in that order by `composeNode`. It replaced six
    parallel callbacks (`resolveFileLabel`/`Missing`/`Canvas`/`Image`/
    `Markdown`/`Facets`).
    Three things the six could not do. A caller has ONE document per
    reference, so six closures over the same lookup meant the same key was
    resolved four times per file node. A record is plain DATA, which a
    function can never be — a function cannot cross `postMessage`, so the
    layout worker receives the records (decision #14's wire) and both
    threads build one seam from them. And a content kind added
    later is a field rather than a seventh callback threaded through every
    consumer, of which there are four.
    The price, stated because it is a real behaviour change: one resolver
    means one failure. A throw used to cost the reference one RANK and now
    costs it the whole resolution, falling straight to the plain label. A
    caller that can partially fail has to handle that in its own lookup,
    which is where it has the information to.
    `expandFileNode` stays a separate seam: it is the caller's POLICY over a
    node (the editor decides by on-screen size, export by intrinsic size),
    not something known about the reference.
    `MdastLayoutOptions.resolveEmbed` also stays its own — it is keyed by a
    canvasId appearing in PROSE, a different key space from a spatial node's
    reference, and it serves markdown documents with no file nodes at all.

12. **Line breaking is UAX #14, not a hand-rolled character table**
    (`layout/nodes/mdast-blocks.ts`, `breakSegments`). `css-line-break` with
    `lineBreak: 'strict'` supplies the break opportunities, which is what
    makes CJK wrap at all (the previous wrapper split on ASCII spaces, so a
    Japanese paragraph had no break opportunity anywhere and was emitted as
    one run painting straight through the node border) and what supplies
    Japanese kinsoku for free: a closing character never opens a line, an
    opening character never ends one. This is the one third-party dependency
    besides `zod`, registered in `tools/arch-lint`'s allowed list — deciding
    WHERE a line may break is this package's own job and the answer is a
    Unicode standard. It is pure and DOM-free, so Node, the browser and a
    worker agree, which is what the byte-identical-SVG guarantee needs.
    Consequences worth knowing:
    - **`wordBreak` stays `normal`.** `break-all` would also break English
      mid-word. A segment that alone exceeds `maxWidth` is instead expanded to
      CODE POINTS at the point it arises, so only the string that needs it
      pays. A single code point wider than `maxWidth` is the one irreducible
      overflow and is left to overflow rather than dropped.
    - **A line is ONE run.** Emitting a run per break opportunity also fits,
      and multiplies the SVG's `<text>` elements by the character count of
      every CJK paragraph.
    - **An ATOMIC run (inline code, raw HTML, inline math) is still never
      split** — an interior space in a code span is not a word boundary — so
      it can still overflow. Truncating it belongs to a later ellipsis/fade
      slice, not to the line breaker.
    - **A block's declared width covers its ink** (`blockWidth`). A block
      claiming `maxWidth` while an atomic run paints past it is what let
      `sceneBounds`, the export viewBox and the editor's grow-only auto-fit
      all agree on a size nothing actually fitted in.
    - **Kinsoku holds across an INLINE BOUNDARY, not only inside a run**
      (`layout/nodes/inline-junction.ts`). Every inline node is its own `emit`
      call, so the junction between two was a break opportunity by accident:
      `。` after `` `code` ``, after `**強調**` or after an icon opened a
      line, which this decision forbids. It is asked of
      `uaxSegments` — the same authority, not a table of its own — and a break
      it forbids relocates the stretch already on the line rather than
      splitting a pair no line may split. `forbiddenLineStarts` 4 -> 0, at +2
      runs and +2 lines on the two rows that relocate. A run that PAINTS
      answers U+FFFC at both edges: its EM SPACE placeholder would otherwise
      read to UAX #14 as a space. Left, measured: an ATOMIC run is cut against
      the width left when PLACED, so a relocated one can fade on a roomy line;
      moving it down instead costs `inline-code@320` a line and moves no
      defect column.
    On top of UAX #14, **BudouX narrows the candidates to phrase (文節)
    boundaries for Japanese**, a strict subset of the UAX opportunities, so
    preferring them costs nothing in fit and buys a line that breaks where a
    reader would pause rather than mid-word. Applied only to text containing
    KANA — Chinese and Korean stay on UAX #14, since BudouX ships a separate
    model per script and this package has no evidence yet that it needs them.
    The parser is built on first Japanese text, NOT at module load: its
    constructor turns a ~24KB model into a Map, and charging that to whichever
    lazily-imported chunk pulls this module in turned two apps/web browser
    tests red before it was made lazy.

13. **`parseBody` DEFAULTS to codec's `parseMarkdownBody`** and stays
    overridable. It was a required injected seam only because this package was
    forbidden to depend on codec, and every production caller passed that one
    function — seven identical lines across apps/web (x3), canvas-viewer,
    server-core and mcp-server, plus an option threaded through apps/web's
    `scene-render-core.ts` for a worker chunk that imported codec directly
    anyway. It remains injectable because layout tests parse with a stub for
    the same reason they measure with one: a layout assertion should not fail
    because a markdown parser changed. No bundle grew — every one of those
    consumers already bundled codec in order to pass the function in. BudouX is VENDORED
    (`src/vendor/budoux/`, Apache-2.0, with the equivalence check that was run
    before the dependency was dropped recorded in its README) and NOT a
    dependency: its only entry point re-exports the HTML processor, which
    imports `linkedom` and from there the native `canvas` package, and the
    published mcp-server bundle then fails to build at all. Tree-shaking
    cannot help — esbuild resolves the whole graph before eliminating
    anything — and the deep import is blocked by budoux's `exports` map.
    **What cannot wrap is CUT, not left to overflow** (`layout/nodes/truncate.ts`,
    `fitToWidth`): a node label (one line is what makes it a label) and an
    atomic run. The run keeps the longest prefix that fits and is marked
    `truncated`, which the SVG backend paints as a fade — never an ellipsis,
    because a label is cut precisely where width is scarce and three dots
    spend the width they save. `fitToWidth` never returns the empty string for
    non-empty input: one glyph over the edge still says a label is there.
    **The cut falls between GRAPHEMES**, the never-empty unit included: a lone
    👨 is not a narrower family emoji. It is GATED, since segmenting is not
    free — text with no code point at or above U+0300 and no CR cannot hold a
    cluster, so it walks code points; measured on the bench's
    overflowing-label rows, ASCII pays 1.2x and an emoji-bearing label 5.8x.
    Coarse on purpose, and a
    tighter gate is a dead end worth not re-walking: "can this character join
    something" answers yes for every precomposed Hangul syllable, since one
    may follow a jamo L. Only the segmenter can say whether a string HAS a
    cluster, which is the work being avoided. None of this transfers to
    `packages/search`'s snippet cut, which cuts at an arbitrary interior
    offset where a bounded window loses the context regional-indicator
    pairing needs.
    Two carve-outs:
    - **Inline MATH is neither split nor cut.** `a + b + c` cut to `a + b`
      reads as a complete formula that is simply wrong, where cut code or cut
      markup reads as cut. It is the one thing still allowed to overflow, and
      the scoreboard's zeroes are pinned knowing it.
    - **An EDGE label is not cut**, because it floats on the edge rather than
      inside a box, so there is no width to fit it to.
    The fade itself is ONE `<mask>` in `<defs>` with
    `maskContentUnits="objectBoundingBox"`, so it scales to every referencing
    element instead of needing a definition per run, and it is emitted only
    when something is truncated — presence-only, exactly like an absent
    appearance attribute, which is what keeps every existing golden
    byte-identical. Verified honoured by resvg (the PNG export path) as well
    as browsers. A page embedding several of these SVGs repeats the mask id,
    which is harmless precisely because every copy is byte-identical.
    **The SIGNAL is one fact with three readers, and that is the part to keep
    uniform.** The POLICIES above differ for reasons — math is not cut, an
    edge label has no box, a single code point has nothing below it to split.
    The signal differing had none, and it left the commonest case silent:
    three paragraphs in a box holding two rendered as a tidy two-paragraph
    box, while a cut LINE faded. Anything removed now marks the last surviving
    run (`markLastRun`), so a dropped block, a trimmed list item and a cut
    line all say the same thing.
    `sceneDigest` DOES report it now, as `truncated` on the node entry. This
    reverses the earlier "add it when a reader has a reason to act on it" —
    an agent authoring and reading canvases is that reader, and the fade is
    only legible to someone looking at pixels. The fact rides the chrome
    SHAPE because a node's content is a SIBLING of its chrome in the flat
    scene list, so a digest walking top-level nodes could never correlate the
    two on its own.
    **Where the cut is DECIDED is `mdast-blocks.ts`** (`fitBlocksToHeight`),
    not the spatial fitter that calls it: "which part of a block is a line"
    is that module's own knowledge. Granularity steps down blocks -> lines
    (a paragraph's runs) -> list items; `blockquote`/`table`/`code` stay
    whole-block, their children not being lines. Whole-block alone leaves the
    commonest body unbounded — a single long paragraph is ONE block, measured
    at 112px in a 60px node before lines were reachable. Keep-first ("a text
    node never renders empty") stays in `compose-node.ts`, being a
    spatial-node policy rather than a block one.
    `layout/frame-containment-quality.test.ts` counts what the law hides —
    a bound says nothing about how often its escape is taken.
    `layout/nodes/text-wrapping-quality.test.ts` is its scoreboard; see the
    Tests section.

14. **`references/` is the one producer of the reference seams.**
    `LoadedReference` is the record a keeper answers for one referenced
    document — name, raw body, canvas, each optional and independent, none
    of them saying which KIND it is. `referenceSeams(graph, options)` reads
    the graph of those records (keyed by the reference as written, `null`
    for "looked up, nothing there") and builds `resolveAlias`,
    `resolveTitle`, `resolveEmbed` and `resolveReference` together, so the
    one rule that decides what a record is — a body means markdown, whatever
    else it carries; only a bodiless record offers its canvas; a file node
    draws an empty canvas as the card while an embed keeps its frame — is
    applied identically to a file node and to a `![[embed]]`. A surface adds
    what only it knows through `options.extra` (an image asset's URL, a
    facet card) and hands the builder its own alias table and names, which
    answer ahead of any load. `referenceTargets` is the matching single
    definition of what to load; `overlayReferences` layers plain-data chrome
    (labels, dangling marks) for the layout worker and the main thread
    alike. Both layouts accept the bundle as `references` and apply it under
    the individual seams (`withReferenceSeams`), which stay for a test
    probing one alone. `ReferenceWire` is the bundle as DATA — the graph
    plus the alias, title and extras tables over what it names — and
    `referenceSeamsFromWire` rebuilds it across a `postMessage`;
    `apps/web`'s editor builds its seams from the wire it posts, so the two
    threads cannot disagree; `referenceTargets` scans text-node bodies too.
    What a seam answers (`ResolvedReference` and kin) is
    `references/resolved.ts`, so the producer never imports the layout.
    `referenceWireFor` cuts a wire to what a canvas's layout can read, so
    one widened for a drafted body (the overlay's preview) leaves that
    canvas's seams, worker request and content cache alone. What counts as
    a stored picture for `imageTargets` and `referenceWireFor` is model's
    `storedImageRefs`, the definition the keeper's file GC reads too, so a
    picture it keeps is one every layout can draw. Decision #11
    names the drift class; `tools/arch-lint`'s
    `reference-seams-check.test.ts` refuses a seam defined outside this
    directory.

15. **A canvas's theme is resolved IN LAYOUT, per canvas** (ADR-0030
    decisions 4-6; `withCanvasTheme` in `layout/spatial-canvas.ts`,
    `theme/theme-asset.ts`). A `RenderContribution` may register `themes`
    (token bundles by bare name, namespaced like `shapes`) and a `readTheme`
    that answers the id the CANVAS names; `SpatialLayoutOptions.style`
    decides whether that is honoured — `'clean'` (the DEFAULT: decision #10's
    agent never pays unasked) ignores it, `'document'` draws it, and a theme
    id draws that theme unsaved (the session override). Resolution happens at
    the top of `layoutSpatialCanvasInternal`, so an embedded canvas reads its
    OWN facet first and inherits the host's only when it names none — the
    same side of the line `visual.edges`/`visual.shape` already stand on in
    an embed, and deliberately NOT a layout option spread downward through
    `...options`, which is the shape that lets an outer document's setting
    win over an embedded canvas's own.
    What a theme changes: the appearance resolver (the token palette for the
    base resolver's `mode`, through `createSpatialTheme`'s once-unused
    `palette` swap point — so `SpatialAppearanceResolver.mode` exists and
    `createSpatialTheme` stamps it), the label/body font family (declared
    only where `fontAvailable` says a face exists, else the bundled family
    plus a `font-missing` report — the declared family must be the measured
    one), and DEFAULTS an explicit facet always beats: `edgeRouting` where
    no `visual.edges` speaks, `nodeShape` where a node's own facet is silent
    (never a group, which is a frame), `groupFrame` on group chrome.
    A body's FURNITURE is themed with its prose: the palette's optional
    `markdownChrome` becomes the `MarkdownTheme`'s `chromeColor` for every
    body `mdastOptionsFor` composes (`markdownTheme` in `theme-asset.ts`), so
    a code panel, an inline-code backdrop, a blockquote rail, a table's rules
    and a task checkbox belong to the theme rather than to one bundled slate
    — a palette naming none keeps `#818b98`, which is what leaves every
    un-themed board byte-identical. A comment or proposal body is NOT themed
    by it: `layoutCommentBody` sets the theme its density picks, and that
    chrome stays chrome. A mono FAMILY is deliberately not a token — a family
    needs a face on every surface (ADR-0011/0012) and the declared family
    must be the measured one, so it is its own slice, recorded as a
    `ponytail:` on `markdown-theme.ts`'s stack. An
    unknown id draws clean and reports `unknown-theme`; nothing throws.
    `createThemedAppearance` is memoized per (tokens, mode, family) so a
    themed canvas keeps the frozen-singleton property the editor's `useMemo`
    relies on. The content cache key carries the label family, because two
    themes on one cache must not hand each other the other's wrapped lines —
    AND the resolved theme id, because the family alone does not identify a
    theme: `visual.neon` names no `fontFamily`, so a clean render and a neon
    one of the same text node measured to the same key while their `textFill`
    and syntax colours differ, and the first drawn answered the second. The id
    is the honest axis since the palette follows from it; a canvas that
    resolves to no theme keys as it always did under every style, so an
    un-themed cache does not churn. `apps/web`'s worker keeps the same axis on
    the CACHE it picks (`lib/layout-content-caches.ts`), one per (mode, style,
    reference wire).
    `naturalNodeContentSize` goes through the same resolution; a caller
    sizing a node under a theme passes the theme id as `style`, since a
    single-node canvas carries no facet to read. So does
    `layoutSpatialEdges` — it shipped without it, and a drag drew every
    edge crisp and straight over a pencilled, curved committed render.
    A canvas embedded in a MARKDOWN body resolves the same way, through
    `layoutMdastBlocks`'s (`layout/markdown-body.ts`) own `style` — a
    markdown host carries no theme, so `'document'` means the embed's own,
    and the library default stays `'clean'` so every headless caller's bytes
    are unchanged. It shipped without that, and the same board was pencilled
    on the canvas and crisp inside a `![[board]]` in a note.
    `resolveCanvasPalette(canvas, mode)` is the same lookup for a chrome
    that PREVIEWS paint rather than painting — the editor's paper and its
    colour swatches — so a picker and the render read one table; it answers
    the bundled palette for the mode wherever layout would draw clean.
    **Ink** (decision #10's geometry half, `layout/ink/sketch.ts`): a theme
    whose tokens say `ink: 'sketch'` puts `ink: { style, seed, fill? }` on
    every DOCUMENT shape and edge the layout composes — a kind plus
    `seedFromId(id)`, never coordinates, so translate/scale carry it
    untouched and `sceneDigest` sees nothing. Comment and proposal chrome
    are built elsewhere and stay crisp on purpose: the annotation layer has
    to keep reading as chrome. `sketchShape` (rect, ellipse, polygon, the
    cylinder's caps+sides+lid) and `sketchEdge` (the SAME flattened polyline
    the hit-test uses, arrowheads as wing strokes instead of markers) are
    the one decomposition the SVG backend draws from; a coloured node is
    hatched (`fill: 'hatch'`) rather than tinted. Two contracts, both
    property-tested and in the mutation lane: every named coordinate lies
    within the semantic bounds plus `SKETCH_INK_REACH_PX`, which
    `sceneBounds` adds for an inked node (a quadratic never leaves the
    triangle of its three points, so checking the named points checks the
    curve); and the randomness is `styleRandomFromSeed(seed)` with no
    positional input, so a moved box draws the same ink moved.
    Ink amplitude is in canvas units and is NOT scaled by
    `scaleScene`, the same class as arrowheads: a miniature's pencil line is
    relatively bolder, by design.
    **Glow** (ADR-0030 decision 8, `layout/ink/glow.ts`): `Appearance.glow`
    is a radius; the backend blurs the element (σ = half the radius) and
    merges the blur twice under the element itself, so the halo is the
    element's OWN paint and no flood colour is invented. The filter's
    region is declared `userSpaceOnUse` over the scene bounds, one
    definition per (radius, region) with the id derived from both — a
    region relative to the element's box drops an AXIS-ALIGNED STRAIGHT
    EDGE entirely, because its box has zero area; measured on resvg 2.6.2
    and the specification's behaviour, so a browser does the same.
    `glowReachPx` (three deviations, rounded up) is what `sceneBounds` adds
    for a glowing node and what sizes the region, one constant with two
    readers. The theme mapping puts the halo on node chrome and edges ONLY
    (`theme-asset.ts`): a label blurred at three deviations thickened into a
    smudge over the halo pill it already sits on, and a group frame was the
    largest and least informative bloom on the board.
    `filter` is a paint attribute on every painted element (a path,
    a text run, a symbol's `<use>`), and hoist.ts deliberately never lifts
    it: it is not inherited. mcp-server's `glow-raster.test.ts` pins the one
    claim only a rasterizer can check — resvg paints the halo beside a
    horizontal edge — because an unlit export would otherwise read as a
    working one.

**An edge drawn through its STORED bends is the renderer's own**
(`layout/edges/bend-route.ts`, taken inside `routeEdge` before the self-edge
shape and before any computed routing). Every other routing here computes a
path from two boxes and the obstacles between them, so none of them can
honour a point somebody placed; this is what happens INSTEAD of choosing one,
whenever `edge.bends` says where the line goes. It declines — and a route is
computed — for an edge with no bends, and for a point this package cannot
serialize, since `layoutSpatialCanvas` accepts an unparsed canvas and
`formatCoord` throws on a non-finite number.

It lived in `plugin-visual` as a contributed router until
[ADR-0037](../../docs/contributing/adr/0037-model-and-format.md) slice 4,
because JSON Canvas has no waypoint and the model was the format. A renderer
that ignored a field of the edge would drop authored geometry the record
still holds, so the renderer owns it; `package-plugin-visual.md` carries the
reasoning and the reachability gap it leaves.

**An edge with a FREE end is not routed, and that is deliberate for now.**
`nodeAtEnd` (model's) answers `undefined` for a point end exactly as it does
for a dangling reference, so every caller in the edge cluster treats the two
alike and the edge degrades to a zero-length path rather than drawing a line
to the origin. Drawing one — the router taking a box-less end — is
[ADR-0037](../../docs/contributing/adr/0037-model-and-format.md) slice 3b's
job. Until then the model can STORE an end this renderer will not draw, which
is the honest state and is pinned by example rather than left to be found.

**An edge's ALGORITHM is still contributable, not only the geometry it draws
with**, and the seam kept its shape when its first customer left. A
contribution registers `routers` by bare name and answers `readRouting` for
the edges it claims; `composeEdge` asks each contribution in turn, composes
`${namespace}.${name}`, and calls the router it finds — BEFORE `routeEdge`,
so a claiming router also wins over stored bends. A decline (`null`), a name
nobody registered, a path under two points, or a missing endpoint all fall
back to the built-in — never an error, so a document written against another
deployment's plugins still draws. Nothing bundled claims an edge today.

What crosses the seam is a ROUTE (points, and whether they curve), never a
scene node: `pullEdgeOntoOutlines`, the arrowheads, the appearance and the
sketch ink stay here and apply to every edge the same way, so a router
cannot become a second producer of that geometry. The side pass runs BEFORE
any router — fan-out needs to see the whole edge set — so it works in the
built-in vocabulary and a router receives its sides rather than choosing
them.

Selection is a READER rather than a widened payload, and that was measured
rather than assumed: making `visual.edges/v0`'s `routing` accept a
namespaced id put the payload outside `deriveFacetForm`'s vocabulary, so the
facet produced no derived form — silently costing the routing control the
inspector renders. A plugin stores its choice in its OWN facet, exactly as a
plugin adding a silhouette adds it to its own rather than widening
`visual.shape`.

## Conventions

- Every scene-node variant retains semantic provenance (heading `level`,
  list `ordered`/`depth`/`ordinal`, `LinkProvenance` for link/wikiLink/
  embed) as a first-class field — never flatten to visual-only attributes.
  A future a11y parallel-DOM projection reads these fields directly.
- Layout functions are pure: no ambient platform API, only their arguments
  plus the injected `measure`/`renderMath` callbacks.
- `routeEdge`, `resolveEmbed`, `layoutMdastBlocks`, `sceneDigest`, and
  `renderSceneToSvg` never throw on malformed/degenerate input (missing
  endpoints, cycles, zero-sized nodes) — they degrade to a documented
  fallback instead, so one bad reference never aborts layout for the rest
  of the canvas.
- **One producer per geometry, or a parity test.** Any geometry consumed
  by more than one surface — painted by the SVG backend AND hit-tested,
  bounded, translated, or exported — has exactly one producing function;
  when two producers are unavoidable, a parity test pins their agreement
  (precedents: `layout/spatial-geometry-parity.test.ts` for layout
  geometry, `layout/edges/edge-rounding.ts` for the drawn-vs-hit curve). Two
  independently-grown producers of "the same" geometry is the pixel
  version of the Zod schema/interface drift class, and it has shipped
  real defects twice.

## Tests

- Vitest projects: `canvas-render-node` (`vitest.node.config.ts`) and
  `canvas-render-browser` (`vitest.browser.config.ts`, registered in the
  root `test:browser` / `test:browser:trace` scripts).
- `src/test-utils/golden-scene.ts` holds the committed byte-identical SVG
  golden asserted equal in both the node and browser projects
  (`svg/determinism.test.ts` / `svg/determinism.browser.test.ts`) — this is
  the package's headline cross-platform determinism guarantee. Regenerate
  the golden only as a deliberate serializer-format change, reviewed as
  such.
- `src/test-utils/fake-measure.ts` is the shared deterministic measurer for
  layout tests (`./test-utils`) — never a real font/platform text API.
- `test-utils/measure-text-conformance.ts` is what the Node and browser
  measurers owe each other (unkerned, unhinted advances), run by each side's
  `measure-text.conformance` test. The viewer vendors Regular only (+0.8 s
  first paint measured for the rest) and ledgers its synthesised emphasis.
- `layout/spatial-canvas.test.ts`: the union of both former per-consumer
  suites (chrome shape, content placement, degenerate inputs, degradation
  reporting via `onDegrade`, document-order emission, appearance-independent
  geometry) against the single `layoutSpatialCanvas`.
- `layout/translate-scene.test.ts`: identity/additivity, the wrapper-relative
  x rule, and the tripwire asserting exactly `listItem`/`tableCell` emit an
  SVG transform.
- `svg/pixel-golden.browser.test.ts` pixel-level regression harness
  (`toMatchScreenshot`, baselines under `svg/__screenshots__/`) for the
  shape classes a byte-level SVG-string golden cannot protect (sweep-flag/
  coordinate-sign geometry: jump hops, rounded-edge corners, arrowheads,
  rect corner radius) — fixtures and the deliberate `--update`-then-eyeball
  regeneration flow live in `src/test-utils/pixel-golden-scenes.ts`.
  Two of its fixtures are THEMED — one canvas drawn under `visual.sketch`
  and under `visual.neon`, each on its own paper — because every other
  golden here is crisp, so a change to sketch's jitter or neon's blur moved
  no committed pixel and the look layer was judged by nothing. They stay
  text-free like the rest, and for a stricter reason: a baseline is compared
  at zero mismatched pixels on machines whose installed fonts differ, so a
  rendered glyph is the one thing in a scene that cannot be reproduced.
- `layout/nodes/text-wrapping-quality.test.ts` is the text-wrapping SCOREBOARD, the
  same instrument-first shape as the routing one below: 11 corpus cases x 3
  narrow widths, every number pinned EXACTLY. Debt (overflowing runs, worst
  overflow px, blocks whose bbox under-reports their ink) targets zero; price
  (runs, lines, `measure` calls) has no target and exists so a breaking
  strategy that buys quality with a per-character measure loop cannot do it
  silently. Its measurer charges CJK a FULL em, unlike `fake-measure.ts`'s
  uniform 0.6em/char, which understates Japanese by ~40% — the single number
  the scoreboard exists to report. Metrics are an independent oracle
  (`test-utils/text-wrapping-metrics.ts`) that reads geometry off the scene
  and never calls the wrapping code.
- `layout/spatial-canvas.properties.test.ts`'s live-drag parity property
  keeps `layoutSpatialEdges` equal to the edge suffix of
  `layoutSpatialCanvas`. Its generator reads the facet REGISTRY
  (`test-utils/facet-arbitraries.ts`, a thin shaping of facet-engine's
  `facetsArbitrary`, which draws each facet from its own Zod schema through
  model's `arbitraryForSchema`) for all THREE targets — node, canvas and
  edge — rather than a list of facet names, because what it guards is a
  second entry point folding over FEWER facets than the committed layout,
  which a named list cannot cover for a facet registered later.
  Four guards
  keep it honest — one fails when a registered facet of any of the three is
  never drawn, three fail when the drawn node, canvas or edge facets stop
  changing the layout being compared. Adding a facet needs no
  edit here; a schema construct the walk cannot express throws at
  construction naming the path, which is the decision point.
- `layout/edges/edge-routing-quality.test.ts` is the routing SCOREBOARD, and the
  answer to "did that rule change help overall".
  It holds one
  invariant — no routed line runs strictly inside a node body it could have
  gone around — strictly over the named corpus, and COUNTS violations over
  2000 deterministic synthetic layouts, split by which search should have
  stopped each: `own-endpoint` (invisible to `bestCandidate`, since
  `routeEdge` drops both endpoint nodes from its obstacle list),
  `foreign` (`bestCandidate`'s last fallback returning the shortest BLOCKED
  candidate when none of its six is clear), `degenerate` (coincident
  anchors). The exemption is `routeEdge`'s own: a rect STRICTLY containing
  an anchor cannot be routed around; a rect merely touched on its border
  can. The counts are pinned EXACTLY, not as a ceiling, so an improvement is
  as loud as a regression — they are a debt figure whose target is three
  zeroes, at which point the aggregate becomes the strict property. Metrics
  live in `src/test-utils/routing-metrics.ts` and never call `edge-rules.ts`
  (the `reversal-count.ts` independent-oracle contract); layouts live in
  `src/test-utils/routing-corpus.ts`.
- `stryker-targets.mjs` + `stryker.config.mjs` + `vitest.stryker.config.ts` are the MUTATION
  lane (`pnpm mutation:render`, `.github/workflows/mutation.yml`), and they
  answer the question no per-diff gate can: **is a property asserting
  anything at all?** Two here were not — a cache-hit branch no generated run
  reached, and a predicate whose false case a uniform generator produced once
  in a billion draws — and both read as thorough prose while passing under a
  deliberately broken implementation. A surviving mutant is exactly that
  fact, found mechanically instead of by suspicion.
  It is REPORT-ONLY in both of its shapes, never a gate. Triage a survivor the
  way a review finding is triaged — most are a generator that never reaches
  the case, and the fix is a denser domain plus a reachability guard, not more
  runs.
  **On a PR it mutates only the curated files THAT DIFF CHANGED and posts the
  survivors as a sticky comment**; weekly it runs the whole list into an
  artifact. The PR half is what makes the lane real: a weekly artifact is a
  number nobody opens, and this repo has already watched a prose rule decay
  until a hook made it mechanical. Scoping to the diff also answers the
  fairness objection to reporting a score at all — an author is shown their
  own files, not somebody else's debt — and it is why the score is never a
  merge condition: a survivor can be the correct state of the world, and only
  a reader can say.
  **A differential oracle is blind to whatever it SHARES with its subject.**
  When reading a differential
  property, ask what the oracle imports before trusting what it covers.
  **Stryker attributes ANY failure during a mutant's run to that mutant, so a
  flaky suite inflates the score.**
  Read a small delta as
  nothing, and re-run before believing a survivor appeared or vanished.
  **Verify a survivor by hand before acting on it.** The tool can report one
  falsely: measured, `src/layout/seed.ts` is imported by its own test and
  nothing else, so Stryker's related-test selection runs 7 tests against it
  (`svg/format.ts` gets 458), and in that narrow selection its runtime
  mutants come back SURVIVED even where the same edit applied by hand fails
  the suite. That file is excluded from `mutate` for exactly that reason, and
  the general habit is the one `diagnosis-evidence` already asks for — apply
  the edit, run the suite, watch it stay green.
  So read the SCORE of a file whose
  module few tests import as a weak signal, and treat its survivor list as a
  set of hypotheses to check rather than a worklist to burn down — the
  difference is measured in hours.
  **A survivor `judged by` ZERO tests is a runner artefact, not a
  hypothesis — and it is root-caused now.** On `tidy.ts` with
  `coverageAnalysis: 'off'` — every mutant is meant to face all 42 tests —
  19 of 65 survivors came back with `testsCompleted 0`, and the six of
  those checked by hand (the root tie-break, the hop direction, both hop
  arithmetics, the floor's y block) each failed one to three tests when the
  same edit was applied. The cause, found on `sceneDocumentBounds` where
  15 of 15 mutants came back that way: `coverageAnalysis:
  'off'` does NOT make the runner run every test — the vitest runner's
  setup records per-test coverage regardless, and Stryker core plans a
  per-mutant `testFilter` from it whenever the dry run returned any. That
  filter is a regex over test ids the runner builds by joining suite and
  test names with a SPACE (vitest 4's `getTaskFullName`), and vitest 5
  matches it against `fullTestName`, which joins them with ` > `. So no
  test inside a `describe` ever matched: only a top-level `it` could kill,
  and this package has 36 of those against 1312 nested. Measured on the
  same mutants in one sandbox: the space-joined regex skips all 617
  related tests, the ` > ` one runs them and kills. Upstream 10.0.0 still
  joins with a space, so `patches/@stryker-mutator__vitest-runner@9.6.1.
  patch` joins with ` > ` in both places the id is built; the same 15 then
  die in 73 seconds at 1.2 tests a mutant, and the whole file reads 100%
  (136 killed, 5 timed out, 8 minutes) where it read 89.4% with 15
  survivors. The config says `'perTest'` now: with the patched runner it
  yields the same `min-heap.ts` survivors as `'off'` under core 9.6.1, and
  fewer test runs a mutant; the weekly lane runs it as six sharded legs.
  `mutation-comment.mjs` lists a
  zero-test survivor apart from real ones now, under "the lane ran NO test
  against", so the next runner-vs-vitest disagreement reads as the lane's
  defect rather than as a function no test pins. Every score and survivor
  list taken before that date was read through this filter: a kill was a
  top-level test or a hit-limit timeout, and a survivor list was mostly
  the filter's. Read that column before the row: `0` says nothing ran, and
  the edit is still yours to apply.
  An entry is a
  claim about the tests that exist, and a new reader of the same
  comparison can make it false.
  It also pays the other way: a survivor whose LOCATION looks obviously
  killable is often a sub-expression, not the statement.
  Read the columns before concluding the
  tool is wrong.
  **A survivor can mean the file has no INSTRUMENT, not that it has no
  test.**
  Unlike the routing and wrapping scoreboards it
  runs inside the mutation lane, because it costs a second: a cheap
  scoreboard belongs there, and the exclusions in `vitest.stryker.config.ts`
  are about price, not about kind. When a file's survivors cluster in a cost
  model, a tie-break or a search, reach for a scoreboard before writing more
  properties.
  **An equivalent mutant is a real answer, and the reason belongs in the
  source.**
  Write the INVARIANT next to the code, not the
  survivor list — a list goes stale and sends the next reader chasing the same
  fourteen every time the weekly report runs.
  **The list is a BUDGET, and `src/mutation-lane-coverage.test.ts` is what
  keeps it honest.** Mutating every production source file is 9089 mutants
  against the list's 2225 — near two hours at this package's measured ~3s per
  mutant, and most of a working day for the whole package —
  so the lane covers 9 of 47 modules. A list's failure mode is silence: a
  module added next month is not covered, the report still looks healthy, and
  nothing says the lane has been looking at less and less of the code. So both
  numbers are pinned EXACTLY, the same instrument shape as the scoreboards
  below, and adding a source file fails that test until someone decides in the
  diff whether the lane should cover it. The answer may be no; then the count
  moves and the decision is on the record. It also runs on `pre-push`, because
  that decision belongs to the diff that adds the module rather than to
  whoever reads a report months later.
  Two exclusions in the vitest config are about run TIME, not value: the
  routing and text-wrapping SCOREBOARDS above are re-run once per mutant that
  touches their code, and `edge-routing-quality.test.ts` alone is ~22s of the
  project's ~30s.

## Common mistakes (append as review finds them)

- Adding a hand-written interface next to `sceneDigestSchema` instead of
  `z.infer` — the exact drift class zod-schema-discipline exists to
  prevent.
- Reaching for `Set`/`Map` iteration order in `sceneDigest`'s overlap/
  containment/cluster/free-region derivation instead of the documented
  explicit sort + tie-breaker — makes the AI-facing JSON non-reproducible.
- Importing MathJax, opentype.js, or any font/DOM API directly instead of
  going through the `measure`/`renderMath` injection seams.
- Treating every non-endpoint node as a routing obstacle: a rect that
  CONTAINS an edge's endpoint (a group enclosing its members) can never
  be routed around — every detour still has to reach the point inside
  it — so it must be excluded from the obstacle set, or the router falls
  back to a garbage shortest-detour around the whole frame. This applies
  to the COST MODEL as much as to the router: `optimizeSideChoices`'s
  `foreignBodiesFor` used to omit the `fullyContains` filter `routeEdge`
  applies, so the search priced ink through a group frame the router had
  correctly ignored, and could be talked into a dogleg to "save" ink no
  route could avoid. A cost model that disagrees with the router about
  what an obstacle is will trade real quality for an imaginary saving.
- Adding a second producer for geometry that is both drawn and consumed
  elsewhere (hit-testing, bounds) instead of sharing one decomposition —
  the curved-edge highlight/hit mismatch was exactly this drift.

## Paint order is not stored order

`layoutSpatialCanvas` paints every group first, larger before smaller, then
everything else in stored order (`paintOrderOf` in `layout/spatial-canvas.ts`).
Stored order is a Loro map's id order, not the order a caller wrote, so a
group whose id sorted after a member's painted over it once it had a colour:
four of eleven boxes vanished from a diagram the MCP eval lane drew, and the
lane's grader, reading the store, passed it. The one test that pins this
lists the member before the group and asserts the group's chrome comes first
in the scene. A z-order a document actually stores would be the honest
dissolution; until JSON Canvas gives one, containers-behind is the rule.

## The drawing score judges the board, not a mechanism

`quality/drawing-score.ts` (`scoreDrawing(canvas, scene)`, from `/scoring`) reads
a laid-out board as a person would: boxes over boxes, a box across a
frame's edge, an edge's ink through a box it does not connect, a label
over a box or under a frame, content cut to fit, a member jammed against
its frame, a box a few pixels off its row (`nearMisses`: the nearest of
the three anchors on an axis, since a wider box centred on a column IS
lined up, and boxes against boxes only, since a box 6px off the centre of
an 800-wide frame beside it is not — both from a lane reading), two boxes
with less than a readable gap between them (`READABLE_GAP_PX`, which
tidy's margin is held at, since the score reading tidy's own output as
jammed is what set it) —
each a DEBT column that targets zero — beside crossings, bends, ink,
uneven gaps, envelope and density as PRICE. The other instruments here each judge one mechanism on
its own terms; this one judges what any of them, or a model through the
tool surface, actually drew, and the MCP eval lane records it per board
as its `drawing` column. Calibrated in `drawing-score.test.ts` by planting
one defect and reading one; pinned in `drawing-quality.test.ts` over
`test-utils/drawing-corpus.ts`, where each diagram the lane asks for is
drawn as a reference, as a first attempt, and after tidy. Its polyline
geometry is `quality/polyline-geometry.ts`, shared with the routing
scoreboard's oracle and `reversal-count.ts` so a crossing means one thing
across every instrument — and, by a contract
`polyline-geometry.independence.test.ts` holds, imported by nothing under
`layout/`: an oracle sharing a primitive with the router would agree with
its mistakes by construction, so the router keeps its own geometry and
that duplication is the independence. A scene links a label to what it names
through `TextRunNode.annotates`, set by the layout and read by nothing
that paints; the flat scene has no other way back from a label's box.

**Tidy now tidies inside
a frame** (`tidy.ts`): a frame's members are tidied as a canvas of their
own, recursively, and the frame GROWS — never shrinks — to hold them with
`TIDY_MARGIN_PX` on every side, when it is unlocked and it or a member is
in scope; `TidyMove` carries the new size, which `canvas-edit.ts` and the
editor's `applyBoxMoves` apply. Three rules around it, each from a
reading. The frame's top-left stays put — a member hugging that corner is
moved in to the margin instead — because growing up or left staggered the
frame 24px against its peers (measured on `architecture/tidied`: Clients
at x=-24 beside Services at 0, which no column charges and any reader
sees). A frame holding a LOCKED member is held by it: the grouped
`tidy-quality` corpus kept 10 overlapping pairs after everything else
cleared, each a member separated from a locked neighbour inside and then
carried back onto it when the unit moved and the locked one stayed. And a
band that holds an immobile unit aligns to that unit's actual anchor
rather than the grid: the lane's `add a box` task snapped a box added at
y=300 to 304 beside out-of-scope row-mates at 300 (`nearMisses 1`), since
a neighbour that cannot move IS the row, wherever it sits. What tidy still
leaves is a near miss between members of DIFFERENT frames — bands run
among a frame's members and among the frames, never across them — pinned
as the two `architecture/tidied` owes. **Bands read every anchor the
score does** — the near edge, then the centre, then on x the far edge —
since a lane board put a narrower frame 20px off centre under two wider
ones and a tidy banding on left edges alone moved nothing (`nearMisses
2`, before and after). A unit lined up by an earlier anchor is the truth
for the later ones and never moves again; one centred that way keeps its
centre off the grid if it must, which is the one exception the grid
promise now states. A centre or far-edge snap that would put a unit inside
a neighbour's margin yields, because the fixpoint loop otherwise drifts —
the snap jams the unit, the overlap pass hops it away, the next iteration
snaps it back (fast-check found three boxes drifting 128px a tidy).
**A row is ORDERED by its edges as well, when the caller passes
them** (`TidyOptions.edges`; the tidy op and the editor both do): a box
whose connections along its row all lie to one side swaps with the nearest
of them, so a fan-out hub sits between its targets. Measured on the lane's
layered board, the hub at the end of its row reads crossings 1, bends 4,
reversals 2 and the same hub between them 0, 0, 0 with a third less ink;
the skill saying so was read by six trials and followed by none, and a
note on the call's answer by three and acted on by none, so tidy does it
(user decision, 2026-09-10: tidy's side effects are a given, and it goes
in the direction that raises the score). The swap ends the condition that
caused it, which is what keeps a second tidy a no-op; the property that
says so draws edges. **The passes can CYCLE, so the loop stops at
the first state it has already seen rather than only at a fixpoint.**
The first REPEATED state lies ON the cycle, so re-entering from
it walks the same loop and stops on the same state; a fixpoint is the
period-1 case and stops where it always did.
**A vote for the board's `flow` is proportional, because one vote per edge
let a single arrow near 45 degrees decide it.** `mobile -> api` on the
tidied architecture board runs (-320, 320); the classifier took `|dy| >=
|dx|` and called it down. An 8px move made it (-328, 320) and it called it
left — flipping a layered board's whole `flow` from `down` to `left` and
`againstFlow`, which is defined against the winner, from 0 to 2. Nothing
about the drawing had got harder to read; the frame of reference had
moved, and a change measured across that boundary is mispriced by it (one
was — see below). Each arrow now votes for BOTH axes in proportion to its
own displacement, so an arrow on the diagonal splits its vote and decides
nothing, and the 8px move changes each share by 0.01.

Worth
knowing before reaching for the same shape again: the instrument wants
edges near the diagonal to count for both readings, not for neither.

**The frame's margin is an ANCHOR, not only a floor** — a movable unit
within `TIDY_BAND_PX` of `frame.{x,y} + TIDY_MARGIN_PX` snaps onto it. It is
the one thing no band can do: bands run among a frame's members and among
the frames, never across them, so `cli` moved in to its frame's 32 beside
`api` and `sqlite` already at 40 in theirs was one column to a reader and
8px apart to the score.
A member further in than a band is still left alone, which is what keeps
this a snap rather than a normalisation; `leaves a member a whole band past
the margin where it is` pins that boundary, and reverting the anchor to a
plain floor turns four cases red.

**A unit's members are what is more than HALF inside a frame, not what
its box fully contains.**
Majority rather than contact, so a frame does not swallow a
neighbour it overlaps by a corner (pinned both ways, and both thresholds
mutation-checked); frames overlapping each other are resolved by document
order, first claim winning, which is the rule the scoop already had.

**The margin anchor yields to a row the margin rule cannot move, and the
EVAL LANE is what found that it had to.**
So the margin
anchor now yields when a member's anchor already agrees with something at
that level that the margin rule CANNOT reach: anything locked, out of
scope, or held by no frame at all.

The narrowing is the rule, and both directions are pinned. Yielding to any
outside anchor also protects two members of two DIFFERENT frames that are
each about to snap to their own margin — they hold each other where they
are, and the corpus loses exactly the alignment the anchor was added to buy
(`nearMisses` 0 back to 2). Yielding to none is the lane's finding. It only
ever YIELDS, never attracts, which is what keeps it clear of the drift the
guide-line attempt below brought.

**Tidy SETTLES: it returns a state it would not move again, and it checks.**
Three local fixes and one structural one, each measured:

- **A member's grid is laid from its FRAME's corner, not the board's zero**
  (`roundToGrid(v, origin)`). A frame off the grid is snapped like anything
  else, and every member placed against the board's grid is carried that far
  off it — 2446 of 3000 boards needed exactly two tidies for this reason
  alone. Laid from the frame, a member's position is a fact about the frame
  and the two move together. Only a frame that CAN move lays its own grid:
  an immobile one carries nothing, so its members stay on the board's grid,
  which is what the lane's `does not pull a member off a row` example wants.
- **A band may not push a member back OUT past the margin.** The floor runs
  once, before the level's passes, so without this a band undoes it — and
  that is what grew a frame for ever: a far-edge band snapped one member's
  left edge to the grid, dragged its row-mate 3px past the margin, the frame
  grew to hold the escapee, and the level's own snap carried the unit back,
  3px wider every tidy with no member moving at all. Applying the floor
  AFTER the passes instead was tried and is worse than the bug: the overlap
  pass stops getting the last word and the grouped corpus goes from 0
  overlapping pairs to 109.
- **`tidyNodes` re-enters until the state repeats** (`TIDY_MAX_SETTLE_PASSES`).
  The tail the local fixes leave is not a family: membership is GEOMETRIC, so
  a frame that grows to hold a straddler can swallow the box past it, and a
  member the overlap pass pushes out of a frame that cannot grow stops being
  one — 129 of the last 130 failures were exactly that. Rather than make
  membership a fixpoint by hand, the entry point computes the fixpoint it was
  already promising. Cost: one more settling pass on a board tidy actually
  changed — 19ms -> 45ms on a 300-box, 8-frame board, 0.8s -> 1.9s over the
  20000-board sweep.
  **Its ceiling is a measurement, and the first one was a guess that CI
  caught.**
  It is pinned as an example, and the ceiling is 12.
- **The frame pass INSIDE the level's loop was implemented, measured and
  DROPPED.**
  Recorded rather than retried.

The property that guards it is deliberately harsher than the plain-box ones:
a frame drawn off the grid AND off a whole multiple of the margin (on the
grid the two coincide and the commonest class cannot arise), members drawn to
straddle its edges, a second frame, a lock, a partial scope and edges. Every
defect above needed two of those ingredients at once. Five deterministic
examples sit beside it, one per shape, because a property reaches a shape
only on some seeds — an earlier fix in this same investigation survived five
fresh property runs and then failed the example the property had itself
produced.

`tidy.ts` passed the 800-line budget in this change and gave up `tidy-units.ts`
— the units half: what a box, a caller's options and a UNIT are, and
`buildUnits`, which decides who belongs to whom. It is in the mutation lane
because that is where `tidy.ts`'s own survivors had migrated once its
scoreboard existed, so leaving it out would have shrunk the lane's reach while
the report read the same.

**An AXIS is a thing here** (`tidy-axis.ts`). Every rule in `tidy.ts` is
stated once and run twice, and each one used to carry `axis === 'x' ? … : …`
at every read of a position, every write of one, and every pick of an origin
or a floor — 18 of them, each a branch a reader resolves before seeing what
the rule says, and each the one place a rule can be written asymmetrically by
accident. `Axis` is `near` / `size` / `at(fraction)` / `of(pair)` / `moved` /
`shift`, plus `bandFractions` — the anchors a drawer sets on that axis, the
far edge only on x. Its own module rather than filed beside the band pass it
was introduced for, because four passes read it. `tidy-bands.ts` took that
pass and `SnapGuard`, the two things a snap may not buy alignment with.

Both are in the mutation lane for the reason `tidy-units.ts` is, and
`tidy-axis.ts` twice over: a rule written asymmetrically on one axis is the
defect the vocabulary exists to make impossible, and the lane is what checks
that claim rather than restating it. Nothing about tidy's OUTPUT moved when
this was done, and `tidy-quality.test.ts` is why that is checkable rather
than asserted — its debt AND price columns are pinned exactly, so it is the
instrument to re-run first when touching any of these three files.

**Board-wide GUIDE LINES in tidy were implemented, measured and REJECTED
— by the composition score, on its first use as a decision instrument.**
Recorded rather than retried, and NOT as "the idea is wrong": what the
reading says is that the corpus has no board with the shape this fixes.
The honest next step is a corpus case that has it — which is worth doing
only when a real drawing produces one, since inventing the fixture that
justifies the change is how a fixture becomes the convention by accident.

## The composition score judges what the board hands its reader

`quality/composition-score.ts` (`scoreComposition(canvas, scene)`, from
`/scoring`) is
[ADR-0032](../../docs/contributing/adr/0032-composition-axis.md)'s second
axis, scored BESIDE the drawing score and never mixed into it: the drawing
score judges DEFECTS and their price, and the questions left once its debt
criterion saturated — should a hub sit between its targets, should every
frame's first column sit on one line — are not defect questions. One column
per principle of *The Non-Designer's Design Book*, each with a source:
proximity from the Gestalt-in-diagrams work, alignment from Balinsky et
al.'s alignment statistics and grid regularity (DocEng 2009), repetition
from Ngo et al.'s regularity/homogeneity/rhythm (Information Sciences
2003). `contrast` (`treatments`, `roles`) is REPORTED-ONLY and may not be
cited for or against a change — salience manipulations have shown no effect
in some empirical work, and a leg that weak does not carry weight.

**What it may be read to mean is fixed and narrow**: the composition a
drawing hands its reader, never that the drawing was understood. Every
source validates against something else — perceived aesthetics, usability,
perceptual grouping — and none of them on this product's drawings.

Four things the calibration decided that a reader would otherwise re-derive:

- **A group is a FRAME, not a connected component.** With components in the
  set the hand-drawn SEQUENCE reference owed all three of its groups at a
  worst ratio of 5.5 — a message box joined to a participant column at the
  far side of the board, which is that diagram's grammar. A reference owing
  is what the calibration forbids. The cost is that a frameless board is
  silent on proximity, pinned as the blind spot.
- **`guides` alone is not a verdict.** A scattered board shares almost no
  anchors and so resolves to FEW lines, exactly as a composed board does.
  The monotone pair is `offGuide` (elements sharing no line, lower better)
  and `perGuide` (elements per shared line, higher better).
- **An inside gap EQUAL to the outside gap counts as `apart`.** Equal
  spacing gives a reader nothing to group by, so a tie contradicts the frame
  rather than passing it.
- **Tidy is NOT promised to buy proximity.** The drawing score's "tidy never
  adds debt" has no analogue here, because the first reading refuted it:
  `architecture/tidied` owes `apart 1` at ratio 1.4 where neither the
  reference nor the draft owes anything — Services stretched to hold a
  member at its right edge, so its widest internal gap (168px) exceeds its
  members' clearance to the frame below (150px). The scoreboard pins the
  exception so it cannot be lost.

  Read the owe as MILD, and the reason is structural rather than a judgement
  call: C1 scores only groups with a DRAWN BORDER, and common region is a
  stronger grouping cue than proximity — a reader's first pass may be by
  spacing, but the frame is right there settling it. The strong form of this
  column would score IMPLIED groups, which is exactly what taking edge
  components out of the group set gave up. So `apart` on a framed group says
  the spacing argues with the frame, not that the reader is misled.

The column set follows the literature, and the module doc says which
source each column follows (ADR-0031 §7 has the reading). Two things a
session extending it has to know. **A column earns its place by an
empirical ranking, not by being in a metric catalogue**: crossing angle,
angular resolution and node resolution are all standard and all absent,
the first two because an orthogonal route makes them read 1.0 by
construction, the third because 450k drawings found it uninformative.
**The columns stay a vector, and the scoreboard pins the known blind
spot**: a board scattered so far apart that a reader would reject it
scores debt-free, with `density` its only witness — pinned as such in
`drawing-quality.test.ts` rather than papered over, because the same
readings can be produced by drawings nobody would accept. Beyond
calibration, three tests make the instrument believable: each reference
owes no more than its draft on any debt column, tidy never adds debt, and
each planted defect moves only the column that names it.

The second reading was a router finding: the hand-drawn architecture
reference owes three `reversals`, because the router draws a same-row
edge inside a frame as a loop under both boxes with no side pinned. The
column exists so that a change to the side choice is judged by it.

**An edge label that would lie over a box slides off the line** —
`edgeLabelPlacement` in `edge-label-anchor.ts`, the ONE producer for the
renderer's label box and the editor's inline label editor alike, as
`edgeLabelPlacement` already was for the midpoint. The midpoint stays unless a
label of that size centred there overlaps a non-container node (its own
endpoints included); then the nearest clear offset along the segment's
normal wins, above or left before below or right, 8px steps to 128px, and
nothing clear within reach leaves it on the line. The reading that set it:
a model inserting a box into a row left 40–50px edges whose "libsql" label
covered both boxes it joined (`lane/insert` and `lane/insert-roomy` in the
corpus, `labelOverNode 2` before, 0 after). The editor passes its own box
size, so on a short edge it opens beside the line where the label will be
rather than over a box; the two agree on the rule, not on a pixel.

**Two router changes for that finding were measured and rejected**, and
the matrix is what stops them being tried again from argument.
A third
attempt starts from the sweep's debt, not from the reference's price.

**The same-row loop is the cost model's answer, not a search miss** — read
off a traced search (fifth reading) before a third attempt was made.
Not
a router item; recorded so the trace is not taken again.

**Every ink term reads axis-aligned segments only, and the straight
style's routes are diagonals** — so a diagonal back through the edge's
own box (a top-side stub, then the line down to a target below) cost the
search nothing while the score read 63px of it (sixth reading).
What fixed
the board is `diagonalInkThrough` in `overlap-and-intrusion`'s self term,
over the edge's OWN endpoint bodies only: every legitimate straight route
has zero of it, since the diagonal runs from one stub's end to the
other's, so it is the defect itself and belongs at tier 0 as the straight
form of the retrace, not at the price tier. A diagonal through a FOREIGN
body stays the tunnel rule's business, and that rule still reads
axis-aligned segments alone by design. The sweep cannot see any of this
(orthogonal, no diagonals); the drawing corpus is the straight
population, and it moved on one price.

**A named side pair whose route runs through the edge's own box is
overruled** (seventh reading: a model pinned `bottom/top` on every edge,
same-row pairs included, and the same-row one drew a stub down and a
diagonal up through both its boxes, 140px). A named side asks where the
line attaches, and a line through the box it attaches to satisfies
nobody, so `optimizeSideChoices` treats such an edge as free; `routeEdge`
now lets the anchor pass's side win over the edge's own, since the two
differ only where the search overruled — the overrule has to reach the
trial that adopts it and the final render alike. Two things moved with
it. The search is no longer gated at two edges: a lone edge can be its
own problem, and the sweep's single-edge layouts had been keeping
whatever the initial ranking picked, foreign body and all — `foreign` 15
to 7, `own-endpoint` 12 to 10, `interiorInk` 2083 to 955, every price
column down with them. And the coincident-anchor decision changed: a
flush-stacked pair named `bottom/top` used to draw the shared point (an
invisible edge, honouring a degenerate request); the spike its trial
path makes is a route through its own boxes, so it is overruled into a
visible route around the pair.
## The facet score judges what the board SAYS, not where it puts things

`quality/facet-score.ts` (`scoreFacets(canvas)`, from `/scoring`) is
[ADR-0033](../../docs/contributing/adr/0033-facet-vocabulary-axis.md)'s third
axis. The drawing score and the composition axis both read GEOMETRY; a
drawing also distinguishes things by APPEARANCE, which says two things differ
in KIND rather than in position, and nothing else here could see it.

It reads a document's DECLARED partitions — a frame's membership, and a
node's kind — against the TREATMENT each box wears: `node.color`,
`visual.shape/v0` and `visual.symbol/v0`, read through `plugin-visual`'s own
resolvers so an unresolvable payload means here exactly what it means at draw
time. `visual.text/v0` is placement rather than kind, and `visual.theme/v0`
and `visual.edges/v0` are canvas-wide, so none of the three is a distinction
channel. The columns are Moody's semiotic clarity (*The Physics of
Notations*, IEEE TSE 2009): `deficit` (a construct nothing visible carries),
`overload` (one treatment worn by two whole constructs), `excess` (a
treatment whose wearers cut a construct rather than covering it),
`undeclared` (a treatment spent where the board declares no partition at
all), plus `distance` (visual distance, the fewest channels two treatments
differ on) and the reported-only `treatments` and `redundancy`.

**More facets is not better, and the columns are shaped so it cannot be.**
A coverage count would reward exactly the board this axis exists to catch.

**The first reading is the finding, and it is stark**: every board in the
corpus — the hand-drawn REFERENCES included — spends one treatment, reads
`distance 0`, and owes every one of the 22 constructs the corpus declares.
The channel is not under-used, it is unopened, and by everyone rather than
only by the model: the lane boards and the references read identically. So
`facet-quality.test.ts` is a BASELINE, not a set of owes to burn down, and it
deliberately carries none of the reference-beats-draft / tidy-never-adds-debt
validity tests the other two scoreboards do — with every board identical on
every column those pass vacuously, which is the failure ADR-0031 §7 names.
What it pins instead is the uniformity, so the first board to spend anything
is loud, plus one recoloured board proving the columns are not dead.

Three things the calibration decided that a reader would otherwise re-derive:

- **Overload and excess are EXCLUSIVE**, and the first implementation charged
  both on the same board because it tested them independently: spanning two
  classes also fails the "inside one class" test. Worn inside one class
  carries that construct; worn by whole classes carries several (overload);
  worn across a class boundary carries none (excess).
- **`distance 0` means "fewer than two treatments exist"**, never "two
  symbols collide" — two DISTINCT treatments differ on at least one channel
  by construction, so the value cannot mean both.
- **A board with no frame and one node kind declares nothing**, so every
  column is silent on it. That is the blind spot, and the corpus has three of
  them: the sequence diagrams. Pinned in the scoreboard rather than only in a
  unit test.

**A STENCIL is the third declared partition** (ADR-0034): `visual.stencil/v0`
records which registered vocabulary entry a box wears, and `scoreFacets` reads
it beside frame membership and node kind. Measured when it landed, it buys
EXACTLY ONE case that the other two cannot reach — an appearance that CUTS the
frames, one datastore inside each of two frames, which by geometry alone is
`excess`. A board whose frames each hold one kind is already carried by frame
membership, and a board with no frame declares nothing either way. Without the
record, dressing a board by kind would score a real improvement as a defect,
which is why ADR-0034 makes the record load-bearing rather than bookkeeping.
The corpus baseline does not move: no corpus board wears a stencil, so the
partition has one class and is dropped.

**A SCOPED-TAG KEY is the fourth declared partition, and the edges get a
reading of their own** ([ADR-0040](../../docs/contributing/adr/0040-scoped-tags.md)
decision 3). A key K partitions the boxes when every box carries at most one
value under it — the untagged as their own `''` class, like an undressed box —
and `carriedBy` names it by the key (`health`), which needs no declaration:
this is the reading `semantic.class/v0` had until the ADR retired it, and
that partition is gone. When any box carries two values under K the key is
reported in `multi` with the count and partitions nothing: colour cannot mean
two things on one box. Plain tags and the board's own tags are never a
partition. `edges` is the same reading over EVERY edge, judged separately (a
key can partition the boxes and be `multi` on the edges), with one channel —
the edge's colour — carried or contested by an edge key exactly as a box's
colour is by a box key, and counted in `contested` beside the two box
channels. A second edge channel (the stroke's style) is not claimed until a
board spends it. The corpus baseline does not move: no corpus board carries a
tag or colours an edge.

The score is OUTSIDE the mutation lane, for the reason the other two
instruments are. Hand-checked instead, and that check earned its place: it
found a treatment map keyed by the node where an id was wanted — which made
every board read as spending nothing, the very answer the corpus was expected
to give.

**The legend is the layout's answer, read off the score** (ADR-0040 decision
6; `legend/canvas-legend.ts`). `canvasLegend(canvas, appearance)` lists every
scoped-tag key a population's colour is `carried` by, each value with the
swatch its class is drawn in — resolved by the same appearance the layout
paints with, so a legend can never show a colour the box does not wear — and
one `uncarried` flag per population for colour spent with no key. A frame, a
kind or a stencil that carries the colour is NOT listed: it has no values a
legend can name. `layoutSpatialCanvas` attaches it to the top-level scene as
`scene.legend` (never to a miniature), the SVG backend draws it in the
top-left corner of an ENVELOPED document (`svg/legend.ts`, sized by a glyph
estimate since the backend has no measurer) and leaves a fragment alone, and
`renderSceneToKeyedSvg` omits it because the editor draws the same data as
its own overlay. The legend covers no content: `sceneDocumentBounds`
(`scene-bounds.ts`) is the scene's bounds plus a band on the left sized by
`legend/legend-geometry.ts`, a DERIVED envelope reserves it itself, and a
caller passing its own viewBox reserves it with that function
(`sceneEnvelope` in server-core, `renderCanvasForExport` in apps/web).
`sceneBounds` itself is untouched, so a legend moves no digest, no
drawing score and no editor coordinate.

**Colour BY INTENT is applied to the CANVAS before layout, never in the
appearance resolver** (ADR-0040 decision 5's declared layer;
`tags/declared-colours.ts`). `withDeclaredColours(canvas, library)` gives a
box or an edge that carries a value with a declared colour, and has no
colour of its own, that colour; `SpatialLayoutOptions.tagLibrary` (a
`TagLibrary`, plugin-visual's type) is what a caller passes, and
`layoutSpatialCanvasWithAnchors` applies it first. On the canvas so that
the facet score, the appearance and the legend read ONE intent: a legend
judged by a score that reads `node.color` would never list a key the
library coloured if the colour lived in the resolver alone. Two rules,
each mutation-checked: an own colour wins (the library is a default, not a
theme), and a box carrying declared colours under two keys gets none — a
first-wins rule painted one key's meaning over the other's, and the
property caught it. The same canvas object comes back when nothing changes,
so an un-libraried layout keeps the frozen-singleton property the editor's
`useMemo` relies on. `layoutSpatialEdges` applies it too, for the reason it
resolves the theme: a live drag drew edges in the stored colour over a
committed scene that drew them by intent, and the live-drag parity property
now draws a library and tagged edges (its stub resolver reads `edge.color`,
or the step would be invisible to it). In the mutation lane.
