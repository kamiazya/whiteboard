# Export formats

The MCP server exposes two export-shaped tools, each rendered headlessly from
the document's persisted content — neither requires a connected browser client.

| Tool | Output | Notes |
| --- | --- | --- |
| `wb_document_get` | The document's own format | A markdown document comes back as OKF Markdown (YAML frontmatter + Markdown body), lossless round-trip with `wb_workspace_edit`'s `document.set` op. A spatial document comes back as JSON Canvas 1.0 with the `x-whiteboard` extension, round-tripping with other JSON Canvas-compatible tools. Either kind also carries the document's comment `threads` beside `content` when it has any; the conversations are not part of either format's content. |
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

## How large a markdown document may be

One markdown write — the `markdown` field of a `wb_workspace_edit`
`document.create` or `document.set` op, or of `POST /api/v1/workspaces/{id}/documents`
— carries at most **262,144 characters** (256 Ki UTF-16 code units, frontmatter
and body together). A longer one is refused with "markdown is longer than the
262144-character limit for one write" before anything is stored. The count is
characters, not bytes, because the cost of storing a document follows the
character count: the limit is where one write still finishes in about a second.
`wb_body_edit` is held to the same ceiling: an edit that would leave the body
longer than that is refused, though an edit that shrinks an already-longer
body is accepted. Split longer content across documents.

The editor's own writes are bounded too, by the same number and the same
rule — growing a body past it is refused, shrinking one already past it is
not:

- **The markdown editor** refuses a paste or keystroke that would take the
  document past 262,144 characters, leaves the document as it was, and says
  so in a notice at the top of the editor.
- **A browser-kept workspace** does not save a body past the limit: the page
  goes back to what is stored, undoing that change and anything typed after it,
  and a notice at the top says the change was not saved and why. A refusal from
  the daemon's sync routes below is answered the same way, and never retried.
- **The daemon's sync routes** — a document's `update`, the workspace
  document's `update` and `promote` — answer `413` with
  `{"error":"markdown_too_large"}` and store nothing. They also refuse, in
  milliseconds, an update that inserts more than 262,144 characters in one
  piece, before applying it. A promoted workspace is judged by its whole
  history: if a note once took one paste past the limit, even one cut back
  since, a workspace that already holds documents refuses it, naming the
  document, while a workspace with no documents yet takes it whole, since
  nothing is replayed there. The same `update` and `promote` refuse, with
  `400 {"error":"invalid_path"}`, an update or record that would put a document
  at a path outside the path grammar; a document already at such a path can
  still be moved to a valid one. The workspace document's `update` also
  refuses, with `400 {"error":"unreadable_document_meta"}`, an update that
  would leave a readable document with a kind, segment or id this server
  cannot read — which would hide it and everything below it — and, with
  `400 {"error":"document_name_too_long"}`, one that gives a document a name
  longer than 200 characters. A name stored longer before that bound can
  still be kept or shortened.

## How large a text node, a label, a comment and a document name may be

A text node's text — the `text` of a `wb_canvas_edit` `node.add` or
`node.patch`, and what a `node.splice` leaves — carries at most **8,192
characters**; a longer one is refused with "node text is longer than the
8192-character limit for one node". Laying text out is what that costs, and at
the limit one node still finishes in about a second. A splice that shrinks text
already over the limit is accepted.

The daemon's sync routes — a document's `update`, the workspace document's
`update` and `promote` — hold the same bound: an update that adds a node with
more than 8,192 characters of text, or grows a node's text past that, answers
`413` with `{"error":"node_text_too_large"}` and stores nothing; `promote`
names the canvas that holds the node. A node stored longer before the limit
can still be moved, restyled or shortened. A browser-kept workspace holds the
same bound: it does not save a change that adds or grows a node's text past
it — the page goes back to what is stored, undoing that change and anything
typed after it, and a notice at the top says the change was not saved and why.

A label — of an edge, a line or a group — carries at most **1,024
characters**, and one comment message at most **4,096**. Each is laid out
again on every render of its board, at a cost that grows with its length.
`wb_canvas_edit` refuses a longer `label` on `node.add`, `node.patch`,
`edge.add`, `edge.patch`, `line.add` and `line.patch`, and a longer `text` on
`comment.add`; `wb_thread_edit` refuses a longer `body` on `thread.add` and
`message.add`. The editor's label and comment boxes refuse a longer edit and
say why. The daemon's sync routes refuse an update that adds or grows one past
its bound with `413` and `{"error":"label_too_large"}` or
`{"error":"comment_too_large"}`, storing nothing; `promote` names the canvas
that holds it. A browser-kept workspace refuses the same change the way it
refuses an over-long node: nothing is saved, the page goes back to what is
stored, and the notice says why. A label or message stored longer before the
limit still reads, and can still be shortened.

A document's display name carries at most **200 characters**, as a workspace
name does, however it is written: the `name` of `wb_workspace_edit`
`document.create` and `document.move` and of
`POST /api/v1/workspaces/{id}/documents`,
`PUT /api/workspaces/{id}/documents/{path}/name`, the web app's Name field
in the new-document and rename dialogs and its title box above an open
document — both stop taking characters at the limit, and the title box says
beside itself why a rename was refused — and a markdown document's
frontmatter `title`, which becomes its name. An
over-long `title` is refused before anything is written — `document.create`
creates nothing, and through `/api/v1` the answer is
`400 {"error":"okf_parse_failed"}` naming the `frontmatter-title` stage. A
blank name still clears it, and a name stored before the limit still lists.

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
- A preserved value must survive being stored and written back out. These are
  refused with a typed error rather than stored as something else — a write
  over `/api/v1` answers `400 okf_not_yaml_safe`, naming the key:
  - `NaN`, `Infinity` and `undefined`, which YAML cannot carry;
  - a YAML type that is not a plain list or mapping — `!!set`, `!!omap` — and
    `!!binary`, which the store would flatten to an empty mapping or a list of
    byte values; write a plain list or mapping, or a string;
  - an integer a double cannot hold exactly, in practice one past 2^53
    (9007199254740992), which would be rounded to the nearest double and read
    back as a different number; write it as a quoted string.
- A spelling that means the same number is normalised, not refused: `0x10`
  reads back as `16`, `0o17` as `15`, `1e3` as `1000`, `1.0` as `1`. A value
  written as `012` reads back as `12`, as YAML 1.2 defines it. A mapping key
  that is a list or mapping, not a string, is stored under its text (`? [a, b]` becomes the key `"[ a, b ]"`), and a number
  used as a key becomes a string.

Values are not validated against the OKF spec: a malformed `verified` block is
carried through as faithfully as a well-formed one, because a consumer that
rejects a document for an unrecognized field is exactly what OKF's conformance
section forbids.

## The `x-whiteboard` extension contract

Extended JSON Canvas output is standard JSON Canvas 1.0 plus **exactly one**
extension key, `x-whiteboard`, allowed at three sites:

- **Document root** — canvas-target facets (`facets`, keyed
  `{namespace}.{name}/v{n}`: `visual.edges/v0` for edge routing and line
  jumps, `visual.theme/v0` for the theme), the board's own tags (`tags`, a
  list of strings — plain tags and `key:value` scoped ones), the ink layer
  (`lines`) and the comment annotation layer (`comments`). Rendering
  preferences for things JSON Canvas already models, so a consumer that
  drops it still renders every edge, just with its own routing.
- **A node** — the canvas-embed extension (`kind: "embed"` plus a canvas
  reference). It records a reference only: the document keeps it and the
  reference graph counts it as a backlink, but nothing draws the embedded
  document and agents cannot author one through MCP. The node also carries node-target
  facets in the same `facets` bucket, and its `tags`.
- **An edge** — edge-target facets (`facets`), the edge's `tags` (a tag on an
  edge classifies the relation: the link between two services is healthy or
  failing as much as the services are) and the bends the line is drawn
  through (`bends`: canvas coordinates, in order, whole pixels here even
  though the document stores them as real numbers). Never an embed: what an
  edge holds that the format cannot state is geometry, not content.
  `visual.edges/v0` here overrides the board's routing for that one edge,
  field by field. A consumer that drops the extension draws the same edge
  with its own computed routing — bends are the clearest case of something
  JSON Canvas simply has no vocabulary for.

No other non-standard field is ever emitted, at any level. Foreign keys on an
imported document (another tool's vendor fields) are stripped on parse and
never re-emitted. Strict-mode output (`wb_document_get` with
`options.strict: true`) drops the `x-whiteboard` key entirely and is plain
JSON Canvas 1.0.

What may appear inside `x-whiteboard` is machine-readable:
[`x-whiteboard.schema.json`](x-whiteboard.schema.json) (JSON Schema,
draft 2020-12) is generated from the same Zod schemas the code validates
with, so it cannot drift from the implementation.

**What each mode costs, field by field**, is
[what a JSON Canvas export costs](json-canvas-loss.md) — every position the
document model can hold, and whether the format states it, rounds it, carries
it on the extension key, or cannot take it. Generated from the projection
itself for the same reason the JSON Schema is.

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

## Tags, the legend and the workspace's tag library

A board whose boxes or edges carry scoped tags exports with its **legend** in the top-left
corner whenever the board's colours follow a key, exactly as the editor shows it (see
[organize with tags](../how-to/organize-with-tags.md#read-the-legend)). When the workspace
declares a [tag library](../how-to/organize-with-tags.md#declare-the-vocabulary) — the document
at `tags` — a box or an edge carrying a value the library colours, and having no colour of its
own, is drawn in the declared colour by `wb_scene_render` and by the daemon's `POST …/export`
and `POST …/export-svg` alike, so the legend lists the key by declaration rather than by
observation. A colour set on the element itself always wins. An untagged board never reads the
library, and a workspace without one exports as stored.

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
never moves because a theme did. A theme id nothing registered is refused — `wb_scene_render` answers
an error and the two export routes a `400 invalid_request` — naming the registered ids, the way a
theme write does.

A themed render also comes back on that theme's **paper**: the background is the theme
palette's surface for the mode asked for (`theme: "dark"` on a neon canvas gives `#030711`),
so an export is the board a person drawing on it sees rather than the theme's strokes on the
bundled sheet. A `clean` render keeps the bundled white or near-black surface. There is no request field for the background
colour.

Both request bodies refuse a field they do not define, naming it in a `400 invalid_request` —
`POST …/export` takes `padding`, `scale`, `theme`, `style`, `outputPath` and `overwrite`, and
`POST …/export-svg` the same without `scale`, since vector output has no resolution to set.

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

**PNG exports carry their document**: the file embeds the canvas's JSON Canvas
document (extended mode, `x-whiteboard` included) in a PNG `iTXt` chunk under
the `whiteboard` keyword — the same pattern
draw.io uses. A shared PNG therefore carries its exact node coordinates and edges, not just
pixels; any PNG chunk reader can recover the document, and image viewers ignore
the chunk. Unlike draw.io, the app does not open such a PNG back as an
editable canvas: a PNG dropped into the editor is inserted as an image.

There is currently no raster (PNG) export tool and no tool that returns image
bytes as MCP `ImageContent` — `wb_scene_render` is the closest equivalent for
handing a rendered canvas back to an LLM.

← Back to [reference](README.md)
