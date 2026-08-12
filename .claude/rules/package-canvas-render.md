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
  Zod-schematized output of this package.

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

- Runtime dependencies: `@kamiazya/whiteboard-canvas-model` (spatial nodes/
  edges + the `./mdast` subset) and `zod` (via `catalog:`), for
  `sceneDigestSchema` only.
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
4. **`ResolvedDocBundle` contract** (`layout/embed-recursion.ts`): minimal,
   internal/versioned shape consumed later by canvas-workspace's View-
   resolution layer. Root depth is `0`; a 4th nesting level is the cap
   hit (depth cap `3`). Cycle detection is PATH-LOCAL — a re-visit on the
   *current* recursion path is a placeholder, but the same doc reached
   again via a disjoint path renders normally. A missing bundle key or an
   explicit `{ unresolved: true }` entry both degrade to the same
   placeholder mechanism. The function is total: it never throws and never
   infinite-loops, on any bundle including dense cyclic ones.
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
   canvas-codec, so `parseBody: (text: string) => MdastRoot` is supplied by
   the caller (both current consumers pass canvas-codec's
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

9. **`ImageSceneNode` and the `resolveFileImage` seam** (J5b): the scene
   graph's one raster/vector image node — `bbox` is the FRAME (aspect always
   preserved via `preserveAspectRatio="xMidYMid meet"`), `href` is emitted
   verbatim (data: URI in exports, blob:/app URL live), `alt` renders as a
   `<title>` child and its absence marks the image presentation.
   `layoutSpatialCanvas`'s `resolveFileImage` is checked BEFORE the
   canvas-embed seam and is not LOD-gated (a scaled-down image is still a
   meaningful thumbnail); any failure keeps the card. Image nodes are
   bbox-only leaves for sceneBounds/translate/scale.

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
      gap-valid-opposing-before-invalid, and incumbent-wins-ties;
      `composeSidePairs` is the composition `rankedSidePairs`
      (`layout/spatial-edges.ts`) wraps, and `shouldAdoptCandidate` is the
      incumbent-wins-ties predicate `optimizeSideChoices` consults. The
      PENALTY half is `PENALTY_RULES`: overlap-and-intrusion (tier 0,
      collinear overlap plus self-retrace/body-intrusion), illegibility
      (tier 1), crossings (tier 2), and realized-bends (tier 3, self-only
      and deliberately last). `pairScore`/`selfScore` (`spatial-edges.ts`)
      compose over the list, and every cost-tuple helper (`ConfigCost`
      shape, `addCost`, `lessCost`, `hasRepairableProblem`) derives from
      the declared tiers, so a new penalty rule is one list entry, never
      a new slot threaded by hand.
    - **Facet-driven rendering rides the injected-resolver pattern**
      (a future `resolveFileFacets`, same seam class as
      `resolveFileCanvas`/`resolveFileImage`), and export stays a pure
      function of the canvas snapshot by default — resolving another
      document's live facet state into exported bytes is opt-in, exactly
      parallel to the style opt-in above.

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
  back to a garbage shortest-detour around the whole frame.
- Adding a second producer for geometry that is both drawn and consumed
  elsewhere (hit-testing, bounds) instead of sharing one decomposition —
  the curved-edge highlight/hit mismatch was exactly this drift.
