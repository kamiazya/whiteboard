# canvas-render — scene graph, pure layout, SVG backend, sceneDigest

## What belongs here

- Plain-TS scene graph types (`scene-graph.ts`): resolved bounding boxes,
  shape kind, text runs, list/heading/table structure, the SVG-fragment
  (math/diagram) seam node, resolved edges.
- Pure layout functions: spatial-canvas edge routing (`layout/spatial-edges.ts`),
  embed recursion over a resolved doc bundle (`layout/embed-recursion.ts`),
  and mdast block layout (`layout/mdast-blocks.ts`) — the single mdast ->
  scene-graph render path shared by preview / spatial text node / export.
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
   clamped. Option sanitization keeps `renderSceneToSvg` total per this
   package's never-throw rule: non-finite/negative `padding` -> `0`;
   non-finite `width`/`height` -> the derived fallback; a `viewBox` with
   any non-finite field -> derived instead of the caller's value.

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

## Common mistakes (append as review finds them)

- Adding a hand-written interface next to `sceneDigestSchema` instead of
  `z.infer` — the exact drift class zod-schema-discipline exists to
  prevent.
- Reaching for `Set`/`Map` iteration order in `sceneDigest`'s overlap/
  containment/cluster/free-region derivation instead of the documented
  explicit sort + tie-breaker — makes the AI-facing JSON non-reproducible.
- Importing MathJax, opentype.js, or any font/DOM API directly instead of
  going through the `measure`/`renderMath` injection seams.
