# Export formats

The MCP server exposes two export-shaped tools, each rendered headlessly from
the document's persisted content — neither requires a connected browser client.

| Tool | Output | Notes |
| --- | --- | --- |
| `wb_document_get` | The document's own format | A markdown document comes back as OKF Markdown (YAML frontmatter + Markdown body), lossless round-trip with `wb_workspace_edit`'s `document.set` op. A spatial document comes back as JSON Canvas 1.0 with the `x-whiteboard` extension, round-tripping with other JSON Canvas-compatible tools. |
| `wb_scene_render` | Vector image (`.svg`) | Rendered from the document's spatial layout (canvas-render's scene graph + SVG backend) — shapes, laid-out Markdown text, and routed edges. |

**The format is not a parameter.** `wb_document_get` answers in whatever
format the document is in, and says which in its `kind` field; there is no
"read this diagram as Markdown". SVG is the one cross-format output, and it is
an explicitly lossy projection rather than a way to read the stored content
(see [ADR-0009](../contributing/adr/0009-mcp-tool-naming.md)).

A document created before formats were recorded has no answer here and is
refused rather than guessed at; writing its content through a `document.set` op
gives it one.

A `file` node renders as a labeled box when exported to SVG; its referenced image
is not embedded in the output.

## OKF frontmatter this server does not model

OKF ([Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md))
requires exactly one frontmatter field, `type`, and leaves producers free to add
any others. This server gives meaning to OKF's required `type`, its recommended
`title`, `description`, `resource` and `tags`, v0.2's trust pair `generated`
and `verified`, and its own `view` and `facets` extension keys.

**Every other root key is preserved verbatim.** Write a document through
a `document.set` op and read it back with `wb_document_get`, and keys this server
has no model for come back at the root they were written at, unchanged. That
covers OKF v0.2's provenance and lifecycle families — `sources`,
`usage_window`, `status`, `stale_after` — and the Attested Computation keys
`runtime`, `parameters`, `computation`, `executor` and `attester`, none of
which this server interprets.

## Who wrote a document

`wb_workspace_edit` takes an optional `actor` for the whole batch, and records
it as OKF `generated.by` alongside the server's clock as `generated.at`. Use
[OKF's actor convention](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md):
`<producer>/<version>` for an agent or tool, `human:<id>` for a person,
`process:<id>` for an automated process.

- Identify yourself. A write with no `actor` is recorded as
  `process:whiteboard-server`, which is true but tells a later reader nothing
  about what produced the content.
- **A document that already declares `generated` keeps it.** Importing a
  document does not make this server its author, so an incoming stamp is
  honoured rather than replaced.
- `verified` is carried through as written, including the single bare mapping
  the spec allows, which is normalised to a one-element list. Nothing in this
  server adds a verification on your behalf: `generated` says who wrote the
  content, `verified` says who confirmed it, and they are different claims.
- The actor is a **self-report**, exactly as it is in OKF. Trust tiers derived
  from it are advisory signals, not access control.

Documents edited in the browser app do not yet carry `generated`; only writes
through the daemon's tools do.

Two consequences worth knowing:

- Preserved keys are emitted in lexicographic order, not authoring order. The
  same normalisation already applies to `facets`.
- A preserved value must be representable in YAML. `NaN`, `Infinity` and
  `undefined` are refused with a typed error rather than written as a corrupt
  document.

Values are not validated against the OKF spec: a malformed `verified` block is
carried through as faithfully as a well-formed one, because a consumer that
rejects a document for an unrecognized field is exactly what OKF's conformance
section forbids.

## The `x-whiteboard` extension contract

Extended JSON Canvas output is standard JSON Canvas 1.0 plus **exactly one**
extension key, `x-whiteboard`, allowed at three sites:

- **Document root** — canvas-target facets (`facets`, keyed
  `{namespace}.{name}/v{n}`: `visual.edges/v0` for edge routing and line
  jumps, `visual.theme/v0` for the theme) and the comment annotation layer
  (`comments`). Rendering preferences for things JSON Canvas already models,
  so a consumer that drops it still renders every edge, just with its own
  routing.
- **A node** — the canvas-embed extension (`kind: "embed"` plus a canvas
  reference), the one piece of content JSON Canvas 1.0 cannot express, and
  node-target facets in the same `facets` bucket.
- **An edge** — edge-target facets (`facets`) and nothing else: an edge has
  no content JSON Canvas cannot express, so this site never carries an
  embed. `visual.edges/v0` here overrides the board's routing for that one
  edge, field by field, and `visual.path/v0` carries the bends the line is
  drawn through (`waypoints`, canvas coordinates, in order — dragged on the
  canvas, or written by an agent through `wb_facet_set`'s `edgeId`). A
  consumer that drops the extension draws the same edge with its own
  routing — bends are the clearest case of a rendering preference JSON
  Canvas does not model.

No other non-standard field is ever emitted, at any level. Foreign keys on an
imported document (another tool's vendor fields) are stripped on parse and
never re-emitted. Strict-mode output (`wb_document_get` with
`options.strict: true`) drops the `x-whiteboard` key entirely and is plain
JSON Canvas 1.0.

What may appear inside `x-whiteboard` is machine-readable:
[`x-whiteboard.schema.json`](x-whiteboard.schema.json) (JSON Schema,
draft 2020-12) is generated from the same Zod schemas the code validates
with, so it cannot drift from the implementation.

## Characters the exporter cannot draw

The daemon rasterises with the fonts **it** has — a vendored Latin face plus
whatever has been installed into its data directory, and deliberately nothing
from the operating system. A character no such face carries is painted as an
empty box.

It is worth reporting because of how it fails. Measurement is correct, so the
text wraps in the right places and every box is the right size; the only thing
wrong is that a reader cannot read it. The daemon's HTTP export routes
therefore answer with the characters they could not draw:

```json
{ "filePath": "…/canvas-a-8f3.png", "undrawable": ["日", "本"] }
```

Empty is the normal answer. What the report means differs by format:

| Format | What was lost |
| --- | --- |
| PNG | The characters are gone from the image. |
| SVG | Nothing yet — the file still carries them as `<text>`, and any viewer whose own system has the face renders them correctly. The report is what a PNG of this file would lose. |

Fix it by installing a font for the script:
[install-fonts-for-export](../how-to/install-fonts-for-export.md).

**The web editor's own exports are a separate question.** They are rendered in
the browser, not by the daemon, so they use the browser's fonts and the report
above does not describe them. A daemon with no Japanese face and a browser with
one disagree about the same canvas — which is why installing a font is worth
doing even when the on-screen canvas looks fine.

## Themes and `style`

A canvas may name a theme in its `visual.theme/v0` facet (bundled: `visual.sketch`,
`visual.neon`; see [choose-a-theme](../how-to/choose-a-theme.md)). Whether a render honours it
is the caller's choice, through one `style` field with one meaning everywhere it appears:

| `style` | draws |
| --- | --- |
| `clean` (default) | the bundled look, whatever the document says |
| `document` | the theme the canvas names, if any |
| a theme id, e.g. `visual.sketch` | that theme, without storing it — a preview |

It appears on `wb_scene_render`, and on the daemon's `POST …/export` (PNG) and
`POST …/export-svg` request bodies. The default is `clean` so an agent reading SVG never pays
for a theme's jittered geometry or glow unasked, and a `wb_canvas_snapshot` layout analysis
never moves because a theme did. A theme id nothing registered draws clean and is reported as a
degradation, never an error.

A themed render also comes back on that theme's **paper**: the background is the theme
palette's surface for the mode asked for (`theme: "dark"` on a neon canvas gives `#030711`),
so an export is the board a person drawing on it sees rather than the theme's strokes on the
bundled sheet. A `clean` render keeps the bundled white or near-black surface, and an explicit
`background` in the request wins over both.

A theme's font family is declared in the SVG only where the daemon can measure it — the
vendored face or an installed one — and otherwise the bundled family is declared, so the face
named and the coordinates measured always agree. `unresolvedFamilies` reports nothing in that
case, because nothing is missing from the page. The daemon reads its fonts directory when it
warms the renderer, so a face installed while it is running is measured and declared from its
next start.

## Web app exports

The web editor's canvas row (More actions → Export) saves the current canvas as
SVG or PNG, rendered with the light palette regardless of the UI mode so an
export's bytes never depend on a display preference — and with the document's
theme, if it names one, since that is part of the document rather than of the
display.

The PNG a browser export produces carries the editor's own font inside the
image data it rasterises from, so it draws the text the editor showed rather
than whatever font the operating system offers. A saved `.svg` names the family
instead of carrying it — a viewer with Roboto renders it identically, and one
without it gets a smaller file.

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
