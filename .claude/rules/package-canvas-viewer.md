---
paths:
  - "packages/canvas-viewer/**"
---

# canvas-viewer — read-only spatial-canvas scene viewer UI

## What belongs here

- This package no longer owns its own `SpatialAppearanceResolver`.
  `viewer-appearance.ts` was deleted by the theme-layer slice
  (package-canvas-render.md decision #8): `CanvasViewer.tsx` now calls
  canvas-render's `createSpatialTheme` directly, with no `onDegrade` (this package degrades silently
  by choice). It builds BOTH modes once at module scope and picks between
  them with the `theme` prop, defaulting to `light`. The viewer has no
  theme switch of its own — that is exactly why the host has to say: the
  SVG is injected markup, so no stylesheet can reach the fills and strokes
  resolved at layout time, and a preview inside a dark app drew the light
  palette on a near-black ground until the prop existed. Body text runs are
  the one part CSS still reaches (canvas-render assigns them no `fill`), so
  a host that themes the viewer sets `fill` on an ancestor too.
- `measure-text.ts`: `createBrowserMeasureText()` — the browser half of
  canvas-render's injected `MeasureText` seam (Canvas 2D `measureText`,
  with a fallback ratio-measurer for environments with no real 2D context
  such as jsdom).
- `font.ts`: `VIEWER_FONT_FAMILY` — the single constant feeding both the
  browser measurer and the widget's build-time font embedding.
- `CanvasViewer.tsx`: lays the canvas out and has the host's Rust core draw
  it in the same call (`layoutSpatialCanvasPicture`, with the theme's
  `VIEWER_APPEARANCES` entry; the core parses a body itself), injecting the
  string through `SceneSvg`. A host that names no size gets the picture at
  the scene's own size with its root `width`/`height` set to `100%`, so CSS
  fits it to the figure and a resize costs no layout (owner decision q89;
  `CanvasViewer.browser.test.tsx` holds it).
  It takes its math and diagrams as canvas-render's fragment TABLE
  (`fragments` + `onFragmentsAsked`), never `renderMath`/`renderDiagram`
  functions, which the layout options no longer have, and lays out through
  the `core` its host hands it (ADR-0054 step 7, S18e) — the host owns the
  wasm instance. `core` is required: there is no TypeScript
  layout to answer without one (S18h).
- `SceneSvg.tsx`: the ONE component that turns a scene's SVG string into
  DOM; apps/web imports it too.
- `widget/`: the self-contained single-file MCP Apps widget build. It lays
  NOTHING out (ADR-0054 S17, owner decision q54): `canvas_view`'s registration
  lays the board out on the daemon and sends `{ svg, boxes }` in the result's
  `_meta` (canvas-render's `canvasViewPictureSchema`, imported through the
  `./canvas-view-picture` subpath so the bundle takes none of the layout), and
  `picture-view.ts` parses that SVG, refuses anything in it that could run,
  and places it in a named `<figure>`. The widget holds —
  build-time font embedding (`build-fonts-module.ts`), the widget entry
  bootstrap, the refresh/comment controls, the click-to-canvas-point
  mapping (`canvas-point.ts`), `widget-tool-calls.ts` (the builders of the
  widget's `canvas_view` / `wb_canvas_edit` requests — import-free so
  mcp-server's contract test and e2e smoke parse the very bytes the widget
  sends), `tool-error-text.ts` (the reason an `isError` result carries, shown on the comment control's alert line — the widget's one status line, for refused comments and failed refreshes alike), `canvas-view-result.ts` (the reader of `canvas_view`'s result — ids, style and theme font from `structuredContent`, the picture from `_meta` —
  the other half of that contract — mcp-server's
  `canvas-view-widget.contract.test.ts` runs the real tool's output
  through it), and `theme-font.ts`: the widget's ONE
  outbound request (ADR-0011's 2026-09-10 note), gated on a pinned
  catalogue origin the widget holds itself, and made only when the picture
  declares the family (ADR-0011's 2026-11-16 correction, q80).

## What does NOT belong here

- Scene graph types, layout, or the SVG serializer itself — those are
  `canvas-render`'s and the core's job; this package only asks for a picture.
- Reading or writing JSON Canvas or OKF text. Nothing here parses a
  document: `CanvasViewer` takes the model, and the widget takes a picture
  (ADR-0054 S17), so this package has no codec dependency at all.
- Any editing affordance beyond the widget's comment (ADR-0024: click to
  pick an anchor, submit one `wb_thread_edit` `thread.add`) — the viewer itself is
  read-only, and the widget's one write goes through the host session to
  `wb_canvas_edit` (widget-entry.test.tsx pins the callServerTool allowlist
  to exactly `canvas_view` + `wb_canvas_edit`). Real editing lives in
  `apps/web`'s editor surfaces. The comment's DELIVERY half (ext-apps
  `sendMessage`, gated on the host's `message` capability) injects a
  user-role message so the model acts on the feedback; it never widens the
  tool allowlist.
- Node/CLI/daemon code — this is a browser-runtime UI package.

## Dependency rules

- Runtime dependencies: `@kamiazya/whiteboard-model`,
  `@kamiazya/whiteboard-canvas-render` (both `workspace:*`), `@modelcontextprotocol/ext-apps`, `react`,
  `react-dom`, `zod`.
- Forbidden imports: `node:*`, `inversify`. DOM globals are this package's
  normal job (browser-runtime UI) — it is held only to the `node:*`/
  `inversify` half of the shared-layer rule, plus one registered
  build-time `Buffer` exemption in `widget/build-fonts-module.ts`.
- Enforced by `tools/arch-lint` (`arch-lint-node` vitest project).

## Conventions

- `SceneSvg`'s markup sink is deliberate, not an unguarded one, and it is
  the only one: `tools/arch-lint`'s `html-sink-ledger.test.ts` fails any
  other `dangerouslySetInnerHTML` or `innerHTML =` in shipped source until it
  is ledgered with a reason. The injected string has exactly two producers,
  both serializers this repo owns: the Rust core's
  (`crates/core/canvas-render/src/svg/serialize.rs` over `xml_escape.rs`) and
  canvas-render's TypeScript backend, which still draws a refused layout's
  notice. Both escape `&`/`<`/`>` in text and `"`/`'` in attribute values.
  The one unescaped part is an `svgFragment` (a formula or diagram), emitted
  verbatim after a well-formedness check; it is trusted because the host's own
  renderer (MathJax, mermaid) produced it, not because the check makes it
  safe. No sanitizer dependency is added because of this.
- The injected SVG is wrapped in a **named `<figure>` element** (the
  element, not `role="figure"` on a div — biome's `useSemanticElements`
  enforces that, and its UA margin is cleared since this is a layout
  container the host sizes), never `role="img"`.
  The SVG's `<text>` runs are real content and, until canvas-render grows
  the a11y projection it defers, the only way a screen reader reaches any
  of it; `img` would supply a name while marking every child
  presentational, buying the label at the cost of the content. The name
  itself comes from the host (`label`, defaulting to "Canvas") because a
  document's name lives in the workspace, never in canvas content
  (vocabulary.md).
- `VIEWER_FONT_FAMILY` and mcp-server's `EXPORT_FONT_FAMILY` name the same
  font family ("Roboto") in two packages that cannot import each other —
  a deliberate, documented duplication (see `font.ts`'s comment). A font
  swap on one side without the other silently desyncs browser/Node export
  metrics rather than failing loudly.
- Emission order (groups first, then the rest in document order, then
  edges) is the Rust layout core's convention, reached through
  `layoutSpatialCanvas`, not something this package re-implements — see
  package-canvas-render.md's resolved decision #7.

## Tests

- Vitest projects: `canvas-viewer-node`, `canvas-viewer-jsdom`,
  `canvas-viewer-browser` (registered in root `vitest.config.ts` /
  `test:browser`).
- Color/preset/ellipse-radius/edge-stroke appearance resolution now lives
  in canvas-render's `theme/spatial-theme.ts` tests, since
  `createSpatialTheme` is shared, not viewer-specific. What stays here is
  that the `theme` prop REACHES it — `CanvasViewer.test.tsx` asserts the
  drawn chrome stroke against each shared palette, which is what a host
  passing the prop into a resolver nobody reads would fail.
  `canvas-viewer-geometry-conformance.test.ts` is this package's tier-2
  conformance test for the theme-layer slice (package-canvas-render.md
  decision #8): asserts `CanvasViewer.tsx` lays out (`layoutSpatialCanvasPicture`) with
  no `geometry` override, so it always resolves to the shared
  `SPATIAL_THEME_GEOMETRY` default.
- `measure-text.ts` has a jsdom-project fallback-measurer test and a
  `.browser.test.tsx` real-Canvas2D contract test (linear scaling with
  `sizePx`, `advanceWidth('') === 0`).
- `smoke:widget` (`packages/canvas-viewer/scripts/smoke-widget.mjs`) exercises the built
  single-file widget in a real browser.

## Render style (ADR-0030)

- `CanvasViewer` takes `style` (`'clean' | 'document' |
  <theme id>`), forwarded to `layoutSpatialCanvas`. Absent is `'clean'`: the
  MCP Apps widget and any embedding host never pay for a theme's jitter or
  glow unasked, the same default as the headless export. A host that wants
  the document's look passes `'document'`.
- `font-loading.ts`'s `hasLoadedFace(family)` is the layout's `fontAvailable`
  seam for a browser realm: the vendored family always, any other only while
  this realm holds a LOADED face for it. It is what the viewer passes, and
  what `apps/web`'s composition passes on both threads through the
  `./font-loading` subpath. A family only the operating system provides
  answers false on purpose — Canvas 2D would draw it and the daemon's
  export could not, and a face the two sides disagree on moves every
  wrapped line.

- The widget's picture carries the theme's paper: server-core's
  `canvasViewPicture` resolves `resolveCanvasPalette(canvas, 'light', { style }).surface`
  into canvas-render's background rect, in the light mode it lays out in.

- `registerFontBytes(family, bytes)` registers a face from bytes in THIS
  realm — a window's document or a worker's global — and records the family
  so `hasLoadedFace` answers from the record rather than by scanning a face
  set that is not iterable everywhere. Memoised per family; never rejects.
  `withViewerFontEmbedded(svg, extraFaces)` carries such faces into a PNG
  export beside the vendored one, and still carries them when the vendored
  face cannot be read.

## Common mistakes (append as review finds them)

- Reaching for a DOM-based HTML sanitizer instead of relying on
  canvas-render's own escaping guarantee.
