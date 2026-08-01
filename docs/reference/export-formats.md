# Export formats

The MCP server exports a canvas through the `export_canvas` tool, selected by its `format`
argument. `export_svg` also exists as a standalone tool with the same underlying behavior for
callers that only need SVG.

| `format` | Output | Rendering |
| --- | --- | --- |
| `png` | Raster image | Always rendered headlessly from the persisted document |
| `svg` | Vector image (`.svg`) | Always rendered headlessly from the persisted document — no browser connection required |
| `json` | Standard `.excalidraw` JSON | Always rendered headlessly from the persisted document |

All three formats accept an optional `outputPath` (must be an absolute path that resolves
inside the workspace's `exports/` directory) and `overwrite`. `png` and `svg` additionally
accept `padding`, `frameId`, and `theme`; `png` alone accepts `scale` and `minFontPx`; `json`
alone accepts `includeCustomFields`.

`png` and `svg` are rendered from the canvas's spatial layout (canvas-render's scene graph +
SVG backend, rasterized by resvg for `png`) — shapes, laid-out Markdown text, and routed edges.
`frameId` and `minFontPx` are accepted for wire compatibility with older callers but are
ignored: the spatial canvas has no frame grouping and no per-element font size to clamp.
A `file` node renders as a labeled box; its referenced image is not embedded in the output.
Exported PNGs no longer embed the canvas's scene data — a `.png` file is a plain raster you
can view or share, not a round-trippable scene document.

All three formats are rendered headlessly from the persisted document and never depend on a
live browser connection, so they all work equally well for automated export pipelines (CI,
scripted diagram linting, doc generation) where no whiteboard client may be attached to the
canvas.

← Back to [reference](README.md)
