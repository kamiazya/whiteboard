---
paths:
  - "packages/canvas-viewer/**"
---

# canvas-viewer — read-only OpenCanvas scene viewer UI

## What belongs here

- `scene.ts`: `ViewerScene` (canvas-model's `SpatialCanvas`, re-exported —
  never redeclared), the total `parseViewerScene`/`serializeViewerScene`
  pair delegating to canvas-codec's `parseSpatial`/`serializeSpatial`.
- This package no longer owns its own `SpatialAppearanceResolver`.
  `viewer-appearance.ts` was deleted by the theme-layer slice
  (package-canvas-render.md decision #8): `CanvasViewer.tsx` now calls
  canvas-render's `createSpatialTheme({ mode: 'light' })` directly (the
  viewer is read-only with no theme switch of its own), alongside
  canvas-codec's `parseMarkdownBody` and no `onDegrade` (this package
  degrades silently by choice).
- `measure-text.ts`: `createBrowserMeasureText()` — the browser half of
  canvas-render's injected `MeasureText` seam (Canvas 2D `measureText`,
  with a fallback ratio-measurer for environments with no real 2D context
  such as jsdom).
- `font.ts`: `VIEWER_FONT_FAMILY` — the single constant feeding both the
  browser measurer and the widget's build-time font embedding.
- `CanvasViewer.tsx`: builds a scene via canvas-render's shared
  `layoutSpatialCanvas` (with `VIEWER_APPEARANCE` and canvas-codec's
  `parseMarkdownBody` injected) and renders it via canvas-render's
  `renderSceneToSvg`, injecting the resulting string with
  `dangerouslySetInnerHTML`.
- `mount.ts`: the imperative `mountCanvasViewer` API for non-React hosts
  (the MCP Apps widget), converting `parseViewerScene`'s result into a
  thrown `ViewerSceneError` at this one imperative boundary.
- `widget/`: the self-contained single-file MCP Apps widget build —
  build-time font embedding (`build-fonts-module.ts`), the widget entry
  bootstrap, refresh/sticky-note controls.

## What does NOT belong here

- Scene graph types, layout, or the SVG serializer itself — those are
  `canvas-render`'s job; this package only calls `renderSceneToSvg`.
- OKF/JSON Canvas parsing internals — this package calls into
  `canvas-codec`'s `parseSpatial`/`serializeSpatial`, it does not
  reimplement them.
- Any editing affordance — this is a read-only viewer. Editing lives in
  `apps/web`'s editor surfaces.
- Node/CLI/daemon code — this is a browser-runtime UI package.

## Dependency rules

- Runtime dependencies: `@kamiazya/whiteboard-canvas-model`,
  `@kamiazya/whiteboard-canvas-codec`, `@kamiazya/whiteboard-canvas-render`
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
  `createSpatialTheme` is shared, not viewer-specific.
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

## Common mistakes (append as review finds them)

- Redeclaring a spatial-canvas schema here instead of re-exporting
  canvas-model's `spatialCanvasSchema` as `viewerSceneSchema`.
- Reaching for a DOM-based HTML sanitizer instead of relying on
  canvas-render's own escaping guarantee.
