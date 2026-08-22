---
paths:
  - "packages/canvas-render/**"
---

# canvas-render — scene graph, pure layout, SVG backend, sceneDigest

## What belongs here

- Plain-TS scene graph types (`scene-graph.ts`): resolved bounding boxes,
  shape kind, text runs, list/heading/table structure, the SVG-fragment
  (math/diagram) seam node, resolved edges.
- Pure layout functions: spatial-canvas edge routing (`layout/spatial-edges.ts`),
  embed recursion over a resolved doc bundle (`layout/embed-recursion.ts`),
  and mdast block layout (`layout/mdast-blocks.ts`) — the single mdast ->
  scene-graph render path shared by preview / spatial text node / export.
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
  one implementation shared by Node/browser/Workers.
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
- The theme/design-token layer (deferred to a later slice) — layout uses a
  small set of fixed geometry constants, not a token system.
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
  in), `css-line-break` (UAX #14 break opportunities) and `zod` (via
  `catalog:`), for `sceneDigestSchema` only.
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
   wrong. Measured, a uniform ratio put `これは日本語です` at 56.8px against
   a true 128px, and `wb_scene_digest` answered `truncated` absent for a node
   the editor was painting a fade on. The predicate is exported because a
   second estimator exists — the text-wrapping scoreboard's corpus measurer,
   which keeps its own Latin ratio but must agree about which code points are
   wide, or the same canvas breaks its lines differently depending on which
   one laid it out.
   A real measurer reads the advance from the font and has no use for the
   predicate — with ONE exception it must handle: a font that lacks the
   glyph. `opentype.js` answers a missing glyph with the `.notdef` advance
   (a flat ~0.44 em in the vendored Roboto), which is not a measurement and
   is worse than the estimate. A real measurer therefore falls back to the
   estimator PER CODE POINT for anything the face does not carry, detected
   by glyph index rather than by comparing advances.
4. **`ResolvedDocBundle` contract** (`layout/embed-recursion.ts`): minimal,
   internal/versioned shape consumed later by loro-adapter's View-
   resolution layer. Root depth is `0`; a 4th nesting level is the cap
   hit (depth cap `3`). Cycle detection is PATH-LOCAL — a re-visit on the
   *current* recursion path is a placeholder, but the same doc reached
   again via a disjoint path renders normally. A missing bundle key or an
   explicit `{ unresolved: true }` entry both degrade to the same
   placeholder mechanism. The function is total: it never throws and never
   infinite-loops, on any bundle including dense cyclic ones.
   The mdast layout carries the CONTENT-bearing sibling of this contract:
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
   Option sanitization keeps `renderSceneToSvg` total per this
   package's never-throw rule: non-finite/negative `padding` -> `0`;
   non-finite or negative `width`/`height` -> the derived fallback; a
   `viewBox` with any non-finite field, or a negative `w`/`h` (SVG forbids
   a negative width/height on `viewBox`, unlike `x`/`y` which may be a
   negative offset), -> derived instead of the caller's value.

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
   regenerating those two). Degenerate-value fallbacks, all "omit, never
   throw": a color/font-family that is not a non-empty string -> omitted; a
   non-finite or negative `strokeWidth`/`fontSize` -> omitted (zero is a
   legitimate value and is kept); `radius` emits `rx` only when finite and
   `> 0` (SVG rejects a negative `rx`, and `rx="0"` is pure noise); a shape
   whose `bbox` has any non-finite field renders as the empty string rather
   than reaching `formatCoord` (which throws by contract) — zero-size and
   negative-w/h boxes DO render (valid, invisible SVG), only non-finite is
   dropped. `shape` emits no `transform`, so it needs no entry in
   `subtreeOffsetX` and the two-renderer tripwire above is unaffected.

7. **`layoutSpatialCanvas` is the single SpatialCanvas -> Scene builder**
   (`layout/spatial-canvas.ts`), replacing two independently-grown builders
   in mcp-server and canvas-viewer. A markdown parser is an injection seam,
   the same class as `measure`/`renderMath`: this package never depends on
   codec, so `parseBody: (text: string) => MdastRoot` is supplied by
   the caller (both current consumers pass codec's
   `parseMarkdownBody`). Appearance is likewise injected via a
   `SpatialAppearanceResolver` (`layout/spatial-appearance.ts`) — a set of
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
   that a user's UI theme can never change exported bytes. The dark-export
   behavior decision was later taken (2026-08-08): `headless-renderer`'s
   `theme: 'dark'` now builds the scene with `createSpatialTheme({ mode:
   'dark' })` and sets `SvgDocumentOptions.textFill` (an inheritable root
   `fill` — the document-level analogue of the editor host's inherited CSS
   fill) so body runs stay legible on the dark background. `theme` is an
   explicit per-request argument; the invariant that ambient UI theme never
   changes exported bytes still holds, and light exports are byte-identical
   to before.
   This decision also fixed a verified, separate defect: export's label
   appearance used to declare `fontFamily: 'sans-serif'` while its measurer
   (`measure-text.ts`) actually measured a vendored Roboto face, so the
   emitted SVG's `font-family` attribute named a different font than the one
   its coordinates were computed from. `theme/font-family.ts`'s
   `SPATIAL_THEME_FONT_FAMILY` ('Roboto') is now what every
   `resolveLabel()` declares. `VIEWER_FONT_FAMILY` (canvas-viewer) and
   `EXPORT_FONT_FAMILY` (mcp-server) still each carry their own literal
   `'Roboto'` string rather than importing this constant — canvas-viewer's
   `font.ts` is reached from `vite.widget.config.ts`, which Node's plain
   config-loading ESM resolver reads directly, and pulling in
   `@kamiazya/whiteboard-canvas-render`'s package export map there fails
   (that package ships TS source with `.js`-suffixed relative imports meant
   for a bundler/type-checker, not Node's native loader). All three
   constants naming the same string remains a deliberate, documented
   duplication rather than a shared import.

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
      existing function. `layout/edge-rules.ts` implements the PREFERENCE
      half: `SIDE_PREFERENCE_RULES` names zero-bend-facing-first,
      dominant-axis-first, l-pair-crowding-tie-break, u-hook-when-degenerate,
      gap-valid-opposing-before-invalid, u-hook-span-exposed-first, and
      incumbent-wins-ties; `composeSidePairs` is the composition
      `rankedSidePairs` (`layout/spatial-edges.ts`) wraps, and
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
      border-tracing sits BELOW crossings rather than adjacent to
      overlap-and-intrusion: the SEARCH evaluates it against unaligned TRIAL
      paths (`computeAnchorsFor`'s pre-`slideAlongSide` representation),
      whose unaligned anchor placement can coincidentally trace a
      bystander's extended border for a real stretch — a false signal a
      genuine crossing never produces (verified against
      `edge-lane-rank.test.ts`'s sweep-rank pin: tier 1 placement adopted a
      route with a real crossing over a crossing-free one).
      endpoint-body-ink sits below border-tracing for the same
      trial-path-artifact reason. Both tiers are re-read against REAL
      geometry by the aligned second run described below, which is where a
      border trace that survives into the drawn route gets repaired. `pairScore`/`selfPenalty`
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
      nothing for the pass to fix. It costs roughly 2x layout time on a
      pathological 200-edge canvas (measured 190ms -> 405ms; 46ms -> 78ms at
      40 edges) and buys own-endpoint violations 35 -> 14, crossings
      647 -> 500, interior ink 3545 -> 2192. Both passes matter: one pass
      leaves `foreign` violations WORSE than not running it at all. Two
      earlier shapes of this same idea were measured and discarded — a
      bespoke repair loop scoring whole configurations (13x layout time),
      then the same loop reusing unchanged paths (4.5x). What made it
      affordable was reusing the search's OWN incremental trial machinery
      instead of writing a second scorer beside it.
    - **Past the optimizer's edge gate the search runs over spatial REGIONS,
      not over nothing.** `CROSSING_OPT_MAX_EDGES` (200) used to skip
      side-choice optimization wholesale, which is not a small loss: measured
      on a 345-edge clustered canvas, 331 avoidable-ink violations — one per
      edge — against 29 across the ~4400 edges of the entire small corpus.
      That is the size an AI-authored document reaches, so the size where
      optimization stops being affordable is not the size where quality stops
      mattering. `optimizeAcrossRegions` groups edges along a Morton curve
      through their midpoints, chunks them into even regions of at most the
      gate, and runs the ordinary two-run search per region. It works because
      interaction is LOCAL: 4-5% of edge pairs survive a bounding-box test on
      the clustered bench cases (55% on the deliberately pathological stride
      canvas). What it gives up, stated plainly: a crossing between edges in
      two different regions is never priced. Result on that canvas —
      violations 331 -> 183, interior ink 42623 -> 21001, border ink
      889 -> 554, at 12ms -> 622ms. Nothing at or under the gate changes, by
      construction (one region, same two runs, same seed).
      Region size is `CROSSING_OPT_MAX_EDGES` itself rather than a second
      knob, deliberately. The measured curve on that canvas is 200 -> 183
      violations, 120 -> 158, 80 -> 122, with time rising 1023 -> 1184 ->
      1481ms: SMALLER regions buy quality, because `TRIAL_BUDGET_EDGES`
      applies per region, so the real knob is total trial budget and the
      region size is only how it is spent. Tuning it against one synthetic
      canvas would make that canvas the convention by accident; the curve is
      recorded here so the next person can move it on evidence.
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
      model is already integer-quantized by `COST_QUANTUM`.) The batch form
      scores every trial edge against ONE base configuration, so a round is
      order-independent and parallelisable, then adopts the non-conflicting
      subset. Sound multi-adoption needs more than disjoint touched sets: a
      pair spanning two proposals changes score and neither proposal costed
      it, so their BOUNDING BOXES must be disjoint too — then every such pair
      scores zero on both sides and the batch equals sequential adoption
      exactly.
      Measured over the corpus: batch needs 6 rounds to converge (12 is
      identical), and at 6 it MATCHES sequential on avoidable-ink violations
      (29) while beating it on crossings (473 vs 500) and ink (2169 vs 2192).
      At the same 2-round budget it is far worse (47 violations, 611
      crossings) — the extra rounds are how it pays for re-basing less often.
      The cost is +36% layout time single-threaded (4471ms vs 3287ms over the
      corpus). That is the whole finding: batch is quality-competitive and
      strictly more work on one thread, and its extra work is exactly the
      work a parallel executor could absorb.
      Deferred rather than shipped because `canvas-render` is a shared-layer
      package with no worker, no SIMD path, and no `navigator.gpu` (a DOM
      global this layer forbids) — so today it would buy a 36% regression for
      a few percent of crossings.
      **Re-measured 2026-08-22 on the then-current search, and the case for
      a parallel executor did not survive.** Batch re-implemented (best
      candidate per edge against one base, disjoint old+new bounding boxes,
      merged configuration re-evaluated) needs ~24 rounds to match the
      sequential search on avoidable ink, not 6, and at that point costs
      4x (345 edges) to 10x (200 edges) the sequential time in interleaved
      `pnpm bench` — not +36%. Profiled, pair scoring — the only part a GPU
      can take, because trial shapes are generated on the CPU — is 46% of
      the 200-edge batch time and under 10% everywhere else; anchors,
      routing and trial bookkeeping are the rest. A WGSL pair-scoring kernel
      was built anyway and held bit-identical to the CPU narrow phase
      (`scoreQuantizedSegmentPair`): 8-10x faster than the CPU at 100k+
      pairs on a real GPU, equal to it on SwiftShader, with a ~2.7ms floor
      per dispatch against rounds of 27-79k pairs. Amdahl's law then puts the
      best achievable batch+GPU layout at ~2.4s for the 200-edge case the
      sequential search does in 0.6s. No production router found (libavoid,
      ELK, yFiles, Excalidraw) parallelises this step; the comparable one
      (Excalidraw's elbow arrows) shrank the routing search space instead.
      Both experiments were left on local branches (`batch-side-choice`,
      `webgpu-pair-scorer`) that were never pushed and are not reachable
      from this repository — so the paragraph above, not a branch, is what
      has to carry the conclusion. Enough to rebuild either: the batch form
      is the one described under the 2026-08-14 measurement (best candidate
      per edge scored against ONE base configuration, adopted where old and
      new bounding boxes are both disjoint, merged configuration
      re-evaluated), and the kernel is one WGSL compute shader over
      `scoreQuantizedSegmentPair`'s integer narrow phase — which is exactly
      why that function was made integer-only and is documented as
      reproducible by a second implementation.
      Do not re-propose GPU or batch search for SPEED; what batch still
      offers is QUALITY on large canvases (345-edge clustered: violations
      183 -> 138, interior ink -22%) at 4x the time, which is a separate
      trade. The speed work goes
      into the CPU-side costs the profile named. Two of the four are done:
      `addCost`/`lessCost` allocation (the trial sums into one scratch
      array) and `routeEdge`'s repeated `deriveDefaultSides` scan.
      `computeAnchorsFor` is done: it gave up its layout-invariant half
      (node index, rects, centers, hoisted into an `AnchorContext` built
      once per search), and its partition is now patched per trial rather
      than rebuilt (`patchAnchorGroups`). Timing its three phases is what
      made the second half tractable — grouping 15.4ms, placement 27.2ms,
      alignment 3.8ms of 46.4ms on the 200-edge bench — because it showed
      alignment could stay a FULL pass. That is the part worth remembering:
      the hard question was which edges' alignment a re-side can flip
      (the aligned run's slide reads group SIZES), and at 8% of the
      function it never had to be answered. `selfPenalty` was measured
      rather than assumed and the answer moved the target: its cost is
      overlap-and-intrusion (10.9% of layout), not border-tracing (3.1%),
      and that term now rejects by axis before measuring.
      **All four are landed, and re-profiling afterwards moved the target
      off that list entirely.** On the 345-edge clustered canvas — the size
      an AI-authored document reaches — `routeEdge` is now 60% of layout,
      and inside it the fallback chain is nearly all of that: the grid
      search `routeOnGrid` 27%, `bestCandidate` 8%, the detour `region`
      union 5%. The elbow shortcut, which the code is written around as the
      common case, is taken on only 292 of 1215 routings there; the grid
      search runs on 719 of them. On the 200-edge grid canvas none of this
      shows (routing is 13%, pair scoring 22%) — so the two bench shapes
      now disagree about where the time is, and a change judged on one of
      them has not been judged.
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
      **It was first written one scope too wide, and the reason is worth
      keeping.** A cache owned by `assignEdgeAnchors` measured exactly the
      same, so nothing flagged it: regions PARTITION the edge list, an edge
      is routed in only the region that holds it, and `routeCacheKey` starts
      with `edge.id` — so a later region can never hit an earlier one's
      entry. Measured 0 cross-region hits on canvases of one, two and four
      regions. The wider scope bought nothing and held every completed
      region's paths until the layout finished. The gap in the reasoning was
      specific: soundness was checked (may these searches share?) and
      usefulness was not (do they ever have anything to share?). A sharing
      change needs both, and the cheap way to get the second is to attribute
      the hits, not to count them.
      **The obstacle preparation was tried and rejected**, the second
      measurement in this series to refuse a change that argued well.
      `routeEdge` rebuilds two 286-element arrays per call — the
      endpoint-containment filter and the margin-inflated copy — 1333 times
      per clustered layout, and only 421 of those filters drop anything.
      Memoizing the inflated array and returning the shared one untouched
      when nothing is dropped measured neutral-to-negative (clustered
      494/502/491 against 508/470/485ms, rounds disagreeing in sign; grid
      slightly worse in all three). The 11% the phase profile attributes to
      those two lines is the SCAN, not the allocation: 1333 calls x 286
      rects x two `containsPoint` tests is 760k tests, and the prototype
      keeps every one of them. Nothing here gets cheaper without cutting
      the obstacle SET down spatially, which changes what is tested rather
      than how fast it is tested.
      A note on method, because it cost a wrong conclusion before it was
      caught: the first interleaved run said the grid canvas regressed 3-4%
      consistently, in all three rounds. Running the same pairs with the
      ORDER FLIPPED said neutral. Whichever variant runs first in a round
      carries that round's warm-up, and three rounds of a fixed order
      reproduce the artifact rather than test it. Alternate the order, not
      only the variant.
    - **Facet-driven rendering rides the injected-resolver pattern.**
      Shipped as the `facets` field of `ResolvedReference`
      (`layout/spatial-canvas.ts`) — synchronous, optional, caller-supplied,
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
      card in turn always outranks the plain label it replaces. Card text goes through `layoutMdastBlocks`
      (`heading`+`paragraph` blocks only, never `list`/`table`, to stay out
      of the `subtreeOffsetX` transform-boundary class); content that
      overflows the node's padded box is truncated at whole-block
      granularity with no "more" affordance (ponytail: that needs a
      focusable DOM-overlay/keyboard treatment this pure-geometry package
      cannot own — upgrade path is an editor-side overlay in a later
      slice). `apps/web` supplies the card (`toFacetCard` in
      `use-canvas-file-seams.ts`); export still resolves nothing by default,
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
    function can never be — the layout worker refuses a canvas whose file
    seams are wired precisely because a function cannot cross
    `postMessage`, and `apps/web`'s `composeReferenceSeam` is now the ONE
    producer both threads build their seam through. And a content kind added
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
    (`layout/mdast-blocks.ts`, `breakSegments`). `css-line-break` with
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
    Four consequences worth knowing:
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
    **What cannot wrap is CUT, not left to overflow** (`layout/truncate.ts`,
    `fitToWidth`): a node label (one line is what makes it a label) and an
    atomic run. The run keeps the longest prefix that fits and is marked
    `truncated`, which the SVG backend paints as a fade — never an ellipsis,
    because a label is cut precisely where width is scarce and three dots
    spend the width they save. `fitToWidth` never returns the empty string for
    non-empty input: one glyph over the edge still says a label is there.
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
    node never renders empty") stays in `spatial-canvas.ts`, being a
    spatial-node policy rather than a block one.
    `layout/frame-containment-quality.test.ts` counts what the law hides —
    a bound says nothing about how often its escape is taken.
    `layout/text-wrapping-quality.test.ts` is the scoreboard for all of this;
    see the Tests section.

## Conventions

- Every scene-node variant retains semantic provenance (heading `level`,
  list `ordered`/`depth`/`ordinal`, `LinkProvenance` for link/wikiLink/
  embed) as a first-class field — never flatten to visual-only attributes.
  A future a11y parallel-DOM projection reads these fields directly.
- Layout functions are pure: no ambient platform API, only their arguments
  plus the injected `measure`/`renderMath` callbacks.
- `routeEdge`, `resolveEmbeds`, `layoutMdastBlocks`, `sceneDigest`, and
  `renderSceneToSvg` never throw on malformed/degenerate input (missing
  endpoints, cycles, zero-sized nodes) — they degrade to a documented
  fallback instead, so one bad reference never aborts layout for the rest
  of the canvas.
- **One producer per geometry, or a parity test.** Any geometry consumed
  by more than one surface — painted by the SVG backend AND hit-tested,
  bounded, translated, or exported — has exactly one producing function;
  when two producers are unavoidable, a parity test pins their agreement
  (precedents: `theme/spatial-geometry-parity.test.ts` for layout
  geometry, `layout/edge-rounding.ts` for the drawn-vs-hit curve). Two
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
  layout tests — never a real font/platform text API.
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
- `layout/text-wrapping-quality.test.ts` is the text-wrapping SCOREBOARD, the
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
- `layout/edge-routing-quality.test.ts` is the routing SCOREBOARD, and the
  answer to "did that rule change help overall". Four reported defects were
  each pinned by the one canvas that exposed it, which could never say
  whether a fix moved the failure somewhere nobody had looked. It holds one
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
