# Export formats

The MCP server exposes three export-shaped tools, each rendered headlessly from
the canvas's persisted document — none of them require a connected browser client.

| Tool | Output | Notes |
| --- | --- | --- |
| `canvas_render_svg` | Vector image (`.svg`) | Rendered from the canvas's spatial layout (canvas-render's scene graph + SVG backend) — shapes, laid-out Markdown text, and routed edges. |
| `canvas_export_okf` | OKF Markdown document (YAML frontmatter + Markdown body) | Lossless round-trip with `canvas_import_okf`. |
| `canvas_export_json_canvas` | JSON Canvas 1.0 (with the `x-whiteboard` extension) | Round-trips with other JSON Canvas-compatible tools; the `x-whiteboard` extension carries whiteboard-specific fields that a strict JSON Canvas reader can safely drop. |

A `file` node renders as a labeled box when exported to SVG; its referenced image
is not embedded in the output.

## Web app exports

The web editor's canvas row (More actions → Export) saves the current canvas as
SVG or PNG, rendered with the light theme regardless of the UI theme so an
export's bytes never depend on a display preference.

**Copy as JSON Canvas** (same menu) puts the extended-mode JSON Canvas
document on the clipboard as plain text — the quickest way to hand the exact
canvas to another tool or a debugging session from any device.

**PNG exports are editable images**: the file embeds the canvas's JSON Canvas
document (extended mode, `x-whiteboard` included) in a PNG `iTXt` chunk under
the `whiteboard` keyword — the same pattern draw.io uses. A shared PNG
therefore carries its exact node coordinates and edges, not just pixels; any
PNG chunk reader can recover the document, and image viewers ignore the chunk.

There is currently no raster (PNG) export tool and no tool that returns image
bytes as MCP `ImageContent` — `canvas_render_svg` is the closest equivalent for
handing a rendered canvas back to an LLM.

← Back to [reference](README.md)
