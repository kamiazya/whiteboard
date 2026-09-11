---
paths:
  - "packages/canvas-viewer/**"
---

# canvas-viewer — read-only spatial-canvas scene viewer UI

## What belongs here

- `scene.ts`: `ViewerScene` (model's `SpatialCanvas`, re-exported —
  never redeclared), the total `parseViewerScene`/`serializeViewerScene`
  pair delegating to codec's `parseSpatial`/`serializeSpatial`.
- This package no longer owns its own `SpatialAppearanceResolver`.
  `viewer-appearance.ts` was deleted by the theme-layer slice
  (package-canvas-render.md decision #8): `CanvasViewer.tsx` now calls
  canvas-render's `createSpatialTheme` directly, alongside codec's
  `parseMarkdownBody` and no `onDegrade` (this package degrades silently
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
- `CanvasViewer.tsx`: builds a scene via canvas-render's shared
  `layoutSpatialCanvas` (with the theme's `VIEWER_APPEARANCES` entry and
  codec's `parseMarkdownBody` injected) and renders it via canvas-render's
  `renderSceneToSvg`, injecting the resulting string with
  `dangerouslySetInnerHTML`.
- `mount.ts`: the imperative `mountCanvasViewer` API for non-React hosts
  (the MCP Apps widget), converting `parseViewerScene`'s result into a
  thrown `ViewerSceneError` at this one imperative boundary.
- `widget/`: the self-contained single-file MCP Apps widget build —
  build-time font embedding (`build-fonts-module.ts`), the widget entry
  bootstrap, the refresh/comment controls, the click-to-canvas-point
  mapping (`canvas-point.ts`), and `theme-font.ts`: the widget's ONE
  outbound request (ADR-0011's 2026-09-10 note), gated on a pinned
  catalogue origin the widget holds itself.

## What does NOT belong here

- Scene graph types, layout, or the SVG serializer itself — those are
  `canvas-render`'s job; this package only calls `renderSceneToSvg`.
- OKF/JSON Canvas parsing internals — this package calls into
  `codec`'s `parseSpatial`/`serializeSpatial`, it does not
  reimplement them.
- Any editing affordance beyond the widget's comment (ADR-0024: click to
  pick an anchor, submit one `comment.add`) — the viewer itself is
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
  `@kamiazya/whiteboard-codec`, `@kamiazya/whiteboard-canvas-render`
  (all `workspace:*`), `@modelcontextprotocol/ext-apps`, `react`,
  `react-dom`, `zod`.
- Forbidden imports: `node:*`, `inversify`. DOM globals are this package's
  normal job (browser-runtime UI) — it is held only to the `node:*`/
  `inversify` half of the shared-layer rule, plus one registered
  build-time `Buffer` exemption in `widget/build-fonts-module.ts`.
- Enforced by `tools/arch-lint` (`arch-lint-node` vitest project).

## Conventions

- `dangerouslySetInnerHTML` in `CanvasViewer.tsx` is deliberate, not an
  unguarded sink: canvas-render's serializer is the SOLE producer of the
  injected string and escapes `&`/`<`/`>` in text and `"`/`'` in attribute
  values (`packages/canvas-render/src/svg/format.ts`). No sanitizer
  dependency is added because of this.
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
- Emission order (nodes, then edges, document order) is canvas-render's
  `layoutSpatialCanvas`'s own convention now, not something this package
  re-implements — see package-canvas-render.md's resolved decision.

## Tests

- Vitest projects: `canvas-viewer-node`, `canvas-viewer-jsdom`,
  `canvas-viewer-browser` (registered in root `vitest.config.ts` /
  `test:browser`).
- `scene.test.ts` / `scene.property.test.ts`: accept/reject example tests
  per parse stage, plus round-trip and totality fast-check properties.
- Color/preset/ellipse-radius/edge-stroke appearance resolution now lives
  in canvas-render's `theme/spatial-theme.ts` tests, since
  `createSpatialTheme` is shared, not viewer-specific. What stays here is
  that the `theme` prop REACHES it — `CanvasViewer.test.tsx` asserts the
  drawn chrome stroke against each shared palette, which is what a host
  passing the prop into a resolver nobody reads would fail.
  `canvas-viewer-geometry-conformance.test.ts` is this package's tier-2
  conformance test for the theme-layer slice (package-canvas-render.md
  decision #8): asserts `CanvasViewer.tsx` calls `layoutSpatialCanvas` with
  no `geometry` override, so it always resolves to the shared
  `SPATIAL_THEME_GEOMETRY` default.
- `measure-text.ts` has a jsdom-project fallback-measurer test and a
  `.browser.test.tsx` real-Canvas2D contract test (linear scaling with
  `sizePx`, `advanceWidth('') === 0`).
- `smoke:widget` (`scripts/smoke-widget.mjs`) exercises the built
  single-file widget in a real browser.

## Render style (ADR-0030)

- `CanvasViewer` and `mountCanvasViewer` take `style` (`'clean' | 'document' |
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

- The widget PAINTS the theme's paper: `widget-entry.ts` resolves
  `resolveCanvasPalette(scene, 'light', { style }).surface` and passes it
  to `mountCanvasViewer`'s `background`, which is canvas-render's
  background rect rather than a CSS colour. `'light'` restates
  `CanvasViewer`'s own default, since the paper has to come from the mode
  the layout drew in.

- `registerFontBytes(family, bytes)` registers a face from bytes in THIS
  realm — a window's document or a worker's global — and records the family
  so `hasLoadedFace` answers from the record rather than by scanning a face
  set that is not iterable everywhere. Memoised per family; never rejects.
  `withViewerFontEmbedded(svg, extraFaces)` carries such faces into a PNG
  export beside the vendored one, and still carries them when the vendored
  face cannot be read.

## Common mistakes (append as review finds them)

- Redeclaring a spatial-canvas schema here instead of re-exporting
  model's `spatialCanvasSchema` as `viewerSceneSchema`.
- Reaching for a DOM-based HTML sanitizer instead of relying on
  canvas-render's own escaping guarantee.
