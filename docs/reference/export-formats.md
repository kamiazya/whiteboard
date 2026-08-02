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

There is currently no raster (PNG) export tool and no tool that returns image
bytes as MCP `ImageContent` — `canvas_render_svg` is the closest equivalent for
handing a rendered canvas back to an LLM.

← Back to [reference](README.md)
