# @kamiazya/whiteboard-canvas-viewer

Read-only spatial-canvas scene viewer, rendered through canvas-render's SVG
backend and shared between `apps/web` and embedded surfaces (MCP Apps
widget, HTML export). Private workspace package — never published to npm.

## Public API

- `<CanvasViewer>` — renders a `SpatialCanvas` (JSON Canvas 1.0 +
  `x-whiteboard`) to an inline SVG via canvas-render's
  `layoutSpatialCanvas` (the shared SpatialCanvas -> `Scene` builder, also
  used by mcp-server's Node export) followed by `renderSceneToSvg`. This
  package supplies `parseMarkdownBody`, canvas-render's shared
  `createSpatialTheme({ mode: 'light' })` (the viewer is read-only and has
  no theme switch of its own), and no `onDegrade` callback — a malformed
  body or unrecognized node kind still renders, silently.
  Pan/zoom/select are the browser's native SVG behavior; there is no
  editing affordance.
- `mountCanvasViewer(container, options)` — imperative mount with an
  embedded-scene slot (`<script data-whiteboard-scene>` or
  `window.__WHITEBOARD_VIEWER_SCENE__`).
  Throws a `ViewerSceneError` if the scene payload fails schema validation.
- `parseViewerScene` (from `./scene`) — a total parser over codec's
  `parseSpatial` and wire schema; it never throws, it returns a
  discriminated `{ ok, value | error }` result.
- `createBrowserMeasureText` (from `./measure-text`) — the browser
  implementation of canvas-render's injected `MeasureText` seam (Canvas 2D
  `measureText`, with a ratio-based fallback for environments with no real
  2D context).
- `serializeSceneForScriptTag` (from `./widget/embed-scene`) — the required
  serializer for a downstream consumer injecting scene JSON into the widget
  build's embedded-scene `<script>` slot (see "Widget build" below). Plain
  `JSON.stringify` is unsafe there: HTML terminates a `<script>` element at
  the literal `</script` byte sequence even inside a JSON string, so scene
  text containing that sequence could break out of the tag.

## Widget build

`pnpm --filter @kamiazya/whiteboard-canvas-viewer build:widget` produces `dist/widget/canvas-viewer.html`: one
self-contained file with all JS, CSS, and the fonts it needs inlined as
base64 data URIs. It mounts via `mountCanvasViewer`, sourcing its scene
exclusively from the embedded-scene slot — a downstream consumer (HTML
export, MCP Apps `ui://` resource) injects the real scene JSON into that
placeholder `<script>` tag without touching the rest of the file, using
`serializeSceneForScriptTag` rather than raw `JSON.stringify` to avoid a
`</script>` breakout.

`pnpm --filter @kamiazya/whiteboard-canvas-viewer smoke:widget` is the runtime gate: it loads the built HTML over
`file://` with full network interception and asserts zero HTTP(S) requests,
a rendered `<svg>`, and that the embedded font actually loaded (not a
silent fallback to a system font).

Font coverage: this package vendors Roboto Regular (Apache-2.0) under
`assets/fonts/Roboto/` — the same face mcp-server vendors under its own
`EXPORT_FONT_FAMILY` constant for Node export, so browser and Node output
agree. Text using glyphs outside Roboto's coverage (e.g. CJK) renders with
the browser's system fallback fonts — visually different but readable.

## Dev/prod export gap

A dependency can behave differently under its development and production
export conditions, and a jsdom or dev-condition unit test only ever sees one
of them. `smoke:widget` therefore runs against the actual production widget
build, so a prod-only behavioral difference cannot hide behind a passing
unit-test suite.
