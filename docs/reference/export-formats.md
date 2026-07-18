# Export formats

The MCP server exports a canvas through the `export_canvas` tool, selected by its `format`
argument. `export_svg` also exists as a standalone tool with the same underlying behavior for
callers that only need SVG.

| `format` | Output | Rendering |
| --- | --- | --- |
| `png` | Raster image | Prefers the connected browser client; falls back to headless rendering when no client is connected |
| `svg` | Vector image (`.svg`) | Always rendered headlessly from the persisted document — no browser connection required |
| `json` | Standard `.excalidraw` JSON | Always rendered headlessly from the persisted document |

All three formats accept an optional `outputPath` (must resolve inside the workspace's
`exports/` directory) and `overwrite`. `png` and `svg` additionally accept `padding`, `frameId`,
and `theme`; `png` alone accepts `scale` and `minFontPx`; `json` alone accepts
`includeCustomFields`.

Because `svg` and `json` never depend on a live browser connection, they are the reliable
choice for automated export pipelines (CI, scripted diagram linting, doc generation) where no
whiteboard client may be attached to the canvas.

← Back to [reference](README.md)
