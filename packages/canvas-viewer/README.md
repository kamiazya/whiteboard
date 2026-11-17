# @kamiazya/whiteboard-canvas-viewer

Read-only spatial-canvas scene viewer, rendered through canvas-render's SVG
backend and shared between `apps/web` and embedded surfaces (MCP Apps
widget, HTML export). Private workspace package — never published to npm.

## Public API

- `<CanvasViewer>` — renders a `SpatialCanvas` (JSON Canvas 1.0 +
  `x-whiteboard`) to an inline SVG via canvas-render's
  `layoutSpatialCanvas` (the shared SpatialCanvas -> `Scene` builder, also
  used by mcp-server's Node export) followed by `renderSceneToSvg`. It
  draws in one of canvas-render's shared `createSpatialTheme` palettes,
  picked by the `theme` prop (`'light' | 'dark'`, default `'light'`): the
  viewer has no theme switch of its own, so its host says which mode it is
  in. Body markdown goes through canvas-render's default parser (codec's),
  and there is no `onDegrade` callback — a malformed body or unrecognized
  node kind still renders, silently. Math and diagrams come from the host as
  a fragment table (`fragments`, with misses reported to `onFragmentsAsked`),
  and the host may hand the Rust core (`core`, canvas-render's `LayoutCore`,
  ADR-0054): the viewer loads no core itself, and `core` is required, since
  no TypeScript layout remains to lay the board out without one.
  Pan/zoom/select are the browser's native SVG behavior; there is no
  editing affordance.
- `createBrowserMeasureText` (from `./measure-text`) — the browser
  implementation of canvas-render's injected `MeasureText` seam (Canvas 2D
  `measureText`, with a ratio-based fallback for environments with no real
  2D context).
- `serializeForScriptTag` (from `./widget/embed-picture`) — the required
  serializer for a downstream consumer injecting a picture into the widget
  build's embedded-picture `<script>` slot (see "Widget build" below). Plain
  `JSON.stringify` is unsafe there: HTML terminates a `<script>` element at
  the literal `</script` byte sequence even inside a JSON string, so SVG
  text containing that sequence could break out of the tag.

## Widget build

`pnpm --filter @kamiazya/whiteboard-canvas-viewer build:widget` produces `dist/widget/canvas-viewer.html`: one
self-contained file with all JS, CSS, and the fonts it needs inlined as
base64 data URIs. It lays nothing out: an MCP Apps host hands it
`canvas_view`'s result, whose `_meta` carries the picture the daemon laid out
(`{ svg, boxes }`, canvas-render's `canvasViewPictureSchema`), and the widget
places that SVG. With no host it shows the embedded-picture slot instead — a
downstream consumer injects a picture into that placeholder `<script>` tag
without touching the rest of the file, using `serializeForScriptTag` rather
than raw `JSON.stringify` to avoid a `</script>` breakout.

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
