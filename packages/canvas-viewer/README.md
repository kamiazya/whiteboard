# @kamiazya/whiteboard-canvas-viewer

Read-only Excalidraw scene viewer, shared between `apps/web` and embedded
surfaces (MCP Apps widget, HTML export). Private workspace package — never
published to npm.

## Public API

- `<CanvasViewer>` — pan/zoom/select-only Excalidraw wrapper.
- `mountCanvasViewer(container, options)` — imperative mount with a
  `messageHandler` seam for embedding hosts and an embedded-scene slot
  (`<script data-whiteboard-scene>` or `window.__WHITEBOARD_VIEWER_SCENE__`).
- `parseViewerScene` (from `./scene`) — validates a `.excalidraw` JSON
  document or a structuredContent-shaped scene payload.

## Widget build

`pnpm build:widget` produces `dist/widget/canvas-viewer.html`: one
self-contained file with all JS, CSS, and the fonts it needs inlined as
base64 data URIs. It mounts via `mountCanvasViewer`, sourcing its scene
exclusively from the embedded-scene slot — a downstream consumer (HTML
export, MCP Apps `ui://` resource) injects the real scene JSON into that
placeholder `<script>` tag without touching the rest of the file.

`pnpm smoke:widget` is the runtime gate: it loads the built HTML over
`file://` with full network interception and asserts zero HTTP(S) requests,
a rendered `<canvas>`, and that the embedded font actually loaded (not a
silent fallback to a system font).

## Dev/prod export gap

`@excalidraw/excalidraw`'s `development` and `production` export conditions
are genuinely different builds — a behavior that only exists in one of them
(font loading via `EXCALIDRAW_ASSET_PATH`, `serializeAsJSON`, etc.) can pass
every jsdom/dev-condition browser test and still be wrong at runtime. This
package's stance:

- Library code (`src/CanvasViewer.tsx`, `src/mount.ts`, `src/scene.ts`) only
  calls dev-safe Excalidraw APIs — nothing that behaves differently between
  the two builds.
- The widget build (`vite.widget.config.ts`, `src/widget-entry.ts`) is a
  **real production build**, and `smoke:widget` is what actually exercises
  prod-only behavior (the widget's font-loading workaround exists
  specifically because of a prod-only difference). Any future addition that
  touches prod-only Excalidraw behavior belongs behind this same smoke, not
  a jsdom/dev-condition test alone.
