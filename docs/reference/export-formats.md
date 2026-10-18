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

**The daemon does not typeset math or draw diagrams.** `wb_scene_render`, the
daemon's `POST …/export` and the `canvas_view` widget draw a `$$` math block as
its TeX source as text, and a `` ```mermaid `` fence as a plain code
block. Inline `$…$` math is drawn as its source text everywhere, the web app
included. In the web app, the note preview, the canvas editor, a past version
opened from version history, and the SVG/PNG exports of either kind (see
[Web app exports](#web-app-exports)) typeset math blocks and draw Mermaid
diagrams — in the document's own text, in a note or board it embeds with
`![[…]]`, and in the note a canvas file node shows. A past version resolves no
embed, so there only the version's own text is typeset. On screen a block
shows its source until its engine has rendered it; an export waits for every
one. The thumbnails and previews in the web app's document list draw them as
source. A Mermaid diagram's labels are drawn as SVG text, so a `$$…$$` label
shows its source and HTML in a label shows as written; a diagram whose
`%%{init}%%` asks for HTML text stays a plain code block (see the
[security model](../explanation/security-model.md#math-and-diagrams-drawn-from-document-text-web-app)).

A document created before formats were recorded has no answer here and is
refused rather than guessed at; writing its content through a `document.set` op
gives it one.

A `file` node renders as a labeled box when exported to SVG; its referenced image
is not embedded in the output.

An inline Markdown image (`![alt](url)`) in a body draws its picture when the
surface resolves the URL to a workspace attachment, or when the URL is
`http:`, `https:` or `data:`. Any other URL — a bare or relative file path,
`file:` — draws as its alt text. The daemon's PNG export goes one step
further and draws only `data:` images: it never reads a file the URL names on
the daemon's host, and never fetches a remote one. Of those it draws only PNG,
JPEG, GIF, WebP and SVG, written as `data:<type>,…` or `data:<type>;base64,…`
with no other parameter, and only when it can read the image's size from its
header. Any other image draws nothing.

## How large a markdown document may be

One markdown write — the `markdown` field of a `wb_workspace_edit`
`document.create` or `document.set` op, or of `POST /api/v1/workspaces/{id}/documents`
— carries at most **262,144 characters** (256 Ki UTF-16 code units, frontmatter
and body together). A longer one is refused with "markdown is longer than the
262144-character limit for one document" before anything is stored. The count is
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
  or a folder at a path outside the path grammar or longer than 1,024
  characters — which is also what keeps a tree of folders from nesting
  deeper than a path can name; a document already at such a path can still be
  moved to a valid one. The
  workspace document's `update` also refuses, with
  `400 {"error":"unreadable_document_meta"}`, an update that would leave a
  readable document or folder with meta this server cannot read — a document's
  kind, segment, id or timestamps, or any key on a folder besides its segment —
  which would hide it and everything below it. A document's `update` refuses,
  with `400 {"error":"invalid_document_root"}`, an update that adds a root
  container named after one of a document node's own keys (`documentId`,
  `segment`, `kind`, `name`, `nameChosen`, `createdAt`, `updatedAt`), or a
  content container under its own name but of another kind (a text named
  `nodes`). The workspace document's `update` also refuses, with
  `400 {"error":"document_name_too_long"}`, an update that gives a document a
  name longer than 200 characters. A name stored longer before that bound can
  still be kept or shortened. The workspace document's `update` and `promote`
  refuse, with `413 {"error":"too_many_documents"}`, an update or record that
  would leave the workspace holding more than 2000 documents; a workspace that
  already holds more still takes edits that add no document, and deleting is
  how it shrinks. Every other way a document is added holds the same ceiling
  and answers it the same way: a document's `update` to a path no document
  holds yet, `POST /api/v1/workspaces/{id}/documents`, a duplicate, a restore
  from the trash, and a version restored to a new path. `wb_workspace_edit`'s
  `document.create` refuses at that op, with the same message. Folders — the
  nodes a path's parts hang from, which hold no document themselves — have a
  ceiling of their own, 4000, answered with
  `413 {"error":"too_many_folders"}` by the workspace document's `update` and
  `promote`, and by a create, a move or a trash restore whose new folders
  would pass it, in the browser and on the daemon alike. A workspace already
  holding more still lists, and still takes a write that adds no folder.
  A sync `update` also refuses, with
  `409 {"error":"causal_gap"}` and nothing stored, an update that builds on a
  change the daemon does not hold; the web app sends it again, and it lands
  once the daemon holds what it builds on.
- **Rewriting references** is held to the same ceilings, the 262,144
  characters of a body and the 8,192 of a text node. Each link is longer than
  the name it replaces, and a moved document's new path can be longer than
  its old one, so either rewrite can grow a text. Link mentions (the
  Connections panel's Link, `POST /api/v1/workspaces/{id}/documents/{documentId}/linkify-mentions`)
  that would carry the body or a node past its ceiling write nothing: the
  route answers `413` with `{"error":"markdown_too_large"}` or
  `{"error":"node_text_too_large"}`, and the mention stays listed. When a move
  follows references, a document the new path would carry past a ceiling is
  left as written, with its references still naming the old path, in the
  browser and on the daemon alike. The daemon reports it among the documents
  the move could not rewrite: in `wb_workspace_edit`'s
  `follow.failedDocumentIds`, or its log for the rename route. The move
  itself stands.

## How large a text node, a label, a comment, a tag and a document name may be

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

A link node's URL, a file node's path, a file node's subpath and a group's
`background` image each carry at most **8,192 characters**. The first three
are drawn as the node's label on every render, at the same per-character cost
as a label, and a background is a location of the same kind; 8,192 leaves room
for long signed or query-heavy URLs. `wb_canvas_edit` refuses a longer `url`,
`file`, `subpath` or `background` on `node.add` and `node.patch`, and the web
app's link dialog stops taking characters at the limit. The daemon's sync routes refuse an update that adds or
grows one past it with `413` and `{"error":"node_location_too_large"}`, storing
nothing; `promote` names the canvas that holds it. A browser-kept workspace
refuses the same change the way it refuses an over-long node. A URL or path
stored longer before the limit still reads, and can still be shortened.

One tag carries at most **1,024 characters**, and one document, board, node
or edge at most **1,024 tags**. Every layout of a board reads each tag its
boxes and edges carry to draw its legend. `wb_facet_set` refuses a longer tag
in `tags.add` or `tags.rename`, more than 1,024 tags in one `tags.add`,
`tags.remove` or `tags.rename`, and a change that would leave something
carrying more than 1,024 — writing nothing for any document named. `wb_workspace_edit`'s `document.set` and
`document.create` refuse a frontmatter `tags` list past either bound the same
way. The daemon's sync routes refuse an update that adds a tag past the length
or grows a node's, edge's or board's tags past the count with `413` and
`{"error":"tags_too_large"}`, storing nothing; `promote` names the canvas that
holds them. A browser-kept workspace refuses the same change the way it
refuses an over-long node. Tags stored past either bound before it existed
still read, and still take a change that does not add to them.

A text anchor's `prefix` and `suffix` — the context either side of a quoted
passage — each carry at most **32 characters**. They tell one occurrence of a
repeated passage from another, and finding the passage compares them against
every occurrence, so their length is paid once per occurrence. `wb_thread_edit`
refuses a longer one on `thread.add`, and `wb_body_edit` on `body.replace`,
with "a text anchor's context is longer than the 32-character limit"; keep the
characters nearest the passage. The editor writes 16. An anchor stored with a
longer context still reads, and only its 32 characters nearest the passage
count toward placing it.

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

A board declares at most **64** semantic axes in `visual.axes/v0` (the facet
keys it treats as meaning, which the legend scores on every layout).
`wb_facet_set` refuses a longer `axes` list with "more axes than the 64-axis
limit for one board", writing nothing. A declaration stored longer before the
limit still reads, and a declared key no box carries costs a render nothing.
The bound is checked where a tool writes the facet; an editor's sync update is
not judged against it, and a longer list arriving that way reads the same way.

## How long an id may be

An id a caller chooses for something it creates carries at most **256
characters**: a node's, an edge's or a line's `id` on `wb_canvas_edit`'s
`node.add`, `edge.add` and `line.add`, a comment's `id` on `comment.add`, a
`threadId` on `wb_thread_edit`'s `thread.add`, a change's `id` on
`wb_body_edit`'s `body.replace`, and the `proposalId` either tool takes. A
longer one is refused with "an id is longer than the 256-character limit for
one id" before anything is written. Ids the server mints are 26 characters or
fewer. An id stored longer before the limit still reads, and an op that NAMES
an existing element — a patch, a removal, an edge end, a reply — still takes
it. `wb_body_edit` likewise refuses an `assumed` passage longer than the
262,144-character limit for one document, since no passage of a body is
longer than the body.

The daemon's sync routes — a document's `update`, the workspace document's
`update` and `promote` — refuse with `413` and
`{"error":"container_name_too_long"}`, storing nothing, an update that brings
a container into the record under a name longer than **1,024 characters**. A
comment thread and a proposal are each a container named by its id, so this
is how an over-long thread or proposal id arriving by sync is answered; kept,
a name far enough past it would leave a record that no keeper can load, every
document in the workspace with it. A container of any kind nested under a key
longer than 1,024 characters is refused the same way, because copying the
document — a save, a duplicate, a trip through the trash — would give the
copy a name that long. A container stored under a longer name or key before
the bound still takes a write, and a copy of its document stays readable. A
browser-kept workspace refuses the same change the way it refuses an
over-long node.

## How many nodes, edges and lines one canvas may hold

One canvas holds at most **2,000 nodes** and at most **2,000 edges and lines
together** — a line (ink) counts against the same bound as an edge, because
the layout routes both the same way and one costs what the other does. Every
render, export, layout read and tidy lays the whole board out again, and the
cost grows with how many edges and lines are routed among how many boxes:
about seven seconds for a board of 2,000 nodes and 2,000 edges, and minutes
for boards several times that size. `wb_canvas_edit` refuses the op that would
take a board past either bound, naming it — "the canvas would hold 2001 nodes,
past the 2000-node limit for one canvas", or "the canvas would hold 2001 edges
and lines, past the limit of 2000 edges and lines together for one canvas" —
and writes nothing; the same bound applies to a batch stored as a proposal. A
`tidy` op's `scope` and a `region.set` op's `nodes` list at most 2,000 ids,
and its `edges` at most 2,000.

The daemon's sync routes — a document's `update`, the workspace document's
`update` and `promote` — refuse an update that grows a board past either bound
with `413` and `{"error":"too_many_nodes_or_edges"}` (the code covers lines
too), storing nothing; `promote` names the canvas. A browser-kept workspace
refuses the same change the way it refuses an over-long node: nothing is
saved, the page goes back to what is stored, and the notice says why. A board
stored past a bound before it existed still reads, and still takes any change
that leaves it no larger — moving, restyling, or replacing one node with
another — so removing nodes, edges or lines is how it shrinks.

## How many open comment threads and proposed changes one document may hold

One document holds at most **500 open comment threads** and at most **1,000
open proposed changes**, across all of its proposals. Every render and export
of a canvas lays its comment bubbles and proposal bubbles out again, each
placed against every box and every bubble before it, so the cost grows faster
than the count: at 2,000 nodes, 500 open threads add about two seconds and
2,000 add about fourteen. Only OPEN ones count — a resolved thread, and an
adopted or dismissed change, stay in the document and are never deleted, so
resolving or deciding is how a document at a limit takes another.

`wb_thread_edit` (a `thread.add`, or a `thread.resolve` that reopens) and
`wb_canvas_edit`'s `comment.add` refuse the op that would pass the thread
limit — "the document would hold 501 open comment threads, past the limit of
500 open comment threads for one document" — and write nothing. A proposal
from `wb_canvas_edit` or `wb_body_edit` is refused when it would leave the
document past the change limit, counting the changes every earlier proposal
still holds open, so a series of small proposals is held to the same limit as
one large one.

The daemon's sync routes refuse an update that would pass either with `413`
and `{"error":"too_many_open_threads"}` or `{"error":"too_many_open_changes"}`,
storing nothing; a browser-kept workspace refuses it the same way it refuses a
board past its size, with a notice. A document stored past a limit before it
existed still reads, and still takes any change that opens nothing.

## How many ops one call may carry

One call of an op-batch tool — `wb_canvas_edit`, `wb_body_edit`,
`wb_thread_edit` and `wb_workspace_edit` — carries at most **200** ops. A
larger batch is refused before any op is applied, with "more ops than the 200-op limit for one call"
(`wb_body_edit` says "passages"); split it across calls, and pass the same
`proposalId` to `wb_body_edit` to keep the passages in one proposal. A text
op whose offsets do not select its quote is found by searching the whole body,
so the bound is what keeps one call's cost near a second on the largest body a
document may hold. `wb_body_edit` stores a proposed passage at the offsets its
quote was found at, as `wb_thread_edit` does for a thread, so reading the
proposal back does not search again.

A `wb_canvas_edit` batch tidies at most once: a second `tidy` op is refused
with "a batch tidies at most once", and nothing is written. One tidy lays out
the whole board, so name every node to tidy in that op's `scope`, or tidy
again in another call.

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
- An actor carries at most **256 characters** — a name, which is stamped on
  every document a batch writes. `wb_workspace_edit`, `POST
  /api/v1/workspaces/{id}/documents`, and the `author` of `wb_thread_edit`,
  `wb_canvas_edit` and `wb_body_edit` refuse a longer one with "an actor is
  longer than the 256-character limit", writing nothing. A `generated.by`
  stored longer, or written in a document's own frontmatter, still reads.

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

`filePath` is absolute on the local daemon. A self-hosted server answers it
relative to the workspace's exports directory instead, so a member is not told
where the server keeps its data.

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

A PNG is at most **16384 pixels a side** and **67,108,864 pixels** (64 Mi) in all, measured
after `scale` and `padding`. A document whose export would be larger is refused with a
`400 invalid_request` naming the size it would have been, before anything is drawn; lower
`scale`, or export SVG, which has no limit.

The inline `data:` images a PNG export draws share the same **67,108,864 pixel** budget,
counted from the width and height each image's header declares and summed across the
document — a decoder allocates what the header declares, however few bytes encode it. A
document past it is refused with a `400 invalid_request` before anything is drawn; shrink or
remove an image, or export SVG.

A theme's font family is declared in the SVG only where the daemon can measure it — the
vendored face or an installed one — and otherwise the bundled family is declared, so the face
named and the coordinates measured always agree. `unresolvedFamilies` reports nothing in that
case, because nothing is missing from the page. The daemon reads its fonts directory when it
warms the renderer, so a face installed while it is running is measured and declared from its
next start.

## Web app exports

The web editor's document row (More actions → Export) saves the open document
as SVG or PNG, rendered with the light palette regardless of the UI mode so an
export's bytes never depend on a display preference — and with the document's
theme, if it names one, since that is part of the document rather than of the
display.

The export draws what the editor shows, including what the document points at:

- **A canvas** exports with its pictures, the note or board a file node points
  at, what a text node embeds with `![[…]]`, and the highlights of comment
  threads about a passage. A file node pointing at another board draws its
  miniature whatever its size on screen, as `wb_scene_render` does with
  `embedReferences`. Math
  blocks and Mermaid diagrams are drawn as the editor draws them, in a text
  node and in the note a file node or an embed shows; `wb_scene_render` draws
  the same canvas with them as source.
- **A markdown note** exports as its laid-out body, at the 720-pixel page
  width `wb_scene_render` uses, with its math blocks, Mermaid diagrams,
  pictures and embeds drawn as the preview draws them — including a math
  block or a diagram inside a quote, a list item or an embedded note. `wb_scene_render` draws
  the same note with math and diagrams as source.

Stored pictures are written into the file as PNG `data:` URIs, so a saved SVG
shows them anywhere it is opened. They are re-encoded from the pixels the
editor shows, so a photo takes more space than its original file and an
animated picture keeps its first frame. A picture whose PNG would be larger
than the 16 MiB upload limit, or one that cannot be read, is left out rather
than linked.

The PNG a browser export produces carries the editor's own font inside the
image data it rasterises from, so it draws the text the editor showed rather
than whatever font the operating system offers. A saved `.svg` names the family
instead of carrying it — a viewer with Roboto renders it identically, and one
without it gets a smaller file.

**Copy as JSON Canvas** (same menu) puts the extended-mode JSON Canvas
document on the clipboard as plain text — the quickest way to hand the exact
canvas to another tool or a debugging session from any device.

**PNG exports of a canvas carry their document**: the file embeds the canvas's JSON Canvas
document (extended mode, `x-whiteboard` included) in a PNG `iTXt` chunk under
the `whiteboard` keyword — the same pattern
draw.io uses. A shared PNG therefore carries its exact node coordinates and edges, not just
pixels; any PNG chunk reader can recover the document, and image viewers ignore
the chunk. Unlike draw.io, the app does not open such a PNG back as an
editable canvas: a PNG dropped into the editor is inserted as an image. A
markdown note has no JSON Canvas form, so its PNG is the picture alone.

There is currently no raster (PNG) export tool and no tool that returns image
bytes as MCP `ImageContent` — `wb_scene_render` is the closest equivalent for
handing a rendered canvas back to an LLM.

← Back to [reference](README.md)
