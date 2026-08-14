# Export formats

The MCP server exposes two export-shaped tools, each rendered headlessly from
the document's persisted content — neither requires a connected browser client.

| Tool | Output | Notes |
| --- | --- | --- |
| `wb_document_get` | The document's own format | A markdown document comes back as OKF Markdown (YAML frontmatter + Markdown body), lossless round-trip with `wb_document_set`. A spatial document comes back as JSON Canvas 1.0 with the `x-whiteboard` extension, round-tripping with other JSON Canvas-compatible tools. |
| `wb_scene_render` | Vector image (`.svg`) | Rendered from the document's spatial layout (canvas-render's scene graph + SVG backend) — shapes, laid-out Markdown text, and routed edges. |

**The format is not a parameter.** `wb_document_get` answers in whatever
format the document is in, and says which in its `kind` field; there is no
"read this diagram as Markdown". SVG is the one cross-format output, and it is
an explicitly lossy projection rather than a way to read the stored content
(see [ADR-0009](../contributing/adr/0009-mcp-tool-naming.md)).

A document created before formats were recorded has no answer here and is
refused rather than guessed at; writing its content through `wb_document_set`
gives it one.

A `file` node renders as a labeled box when exported to SVG; its referenced image
is not embedded in the output.

## The `x-whiteboard` extension contract

Extended JSON Canvas output is standard JSON Canvas 1.0 plus **exactly one**
extension key, `x-whiteboard`, allowed at two sites:

- **Document root** — rendering preferences for things JSON Canvas already
  models (currently `edgeRouting.style` and `edgeRouting.lineJumps`). A
  consumer that drops it still renders every edge, just with its own routing.
- **A node** — the canvas-embed extension (`kind: "embed"` plus a canvas
  reference), the one piece of content JSON Canvas 1.0 cannot express.

No other non-standard field is ever emitted, at any level. Foreign keys on an
imported document (another tool's vendor fields) are stripped on parse and
never re-emitted. Strict-mode output (`wb_document_get` with
`options.strict: true`) drops the `x-whiteboard` key entirely and is plain
JSON Canvas 1.0.

What may appear inside `x-whiteboard` is machine-readable:
[`x-whiteboard.schema.json`](x-whiteboard.schema.json) (JSON Schema,
draft 2020-12) is generated from the same Zod schemas the code validates
with, so it cannot drift from the implementation.

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
bytes as MCP `ImageContent` — `wb_scene_render` is the closest equivalent for
handing a rendered canvas back to an LLM.

← Back to [reference](README.md)
