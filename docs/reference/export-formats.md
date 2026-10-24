# Export formats

The MCP server exposes two export-shaped tools, each rendered headlessly from
the document's persisted content — neither requires a connected browser client.

| Tool | Output | Notes |
| --- | --- | --- |
| `wb_document_get` | The document's own format | A markdown document comes back as OKF Markdown (YAML frontmatter + Markdown body), lossless round-trip with `wb_workspace_edit`'s `document.set` op. A spatial document comes back as JSON Canvas 1.0 with the `x-whiteboard` extension, round-tripping with other JSON Canvas-compatible tools. Either kind also carries the document's comment `threads` beside `content` when it has any; the conversations are not part of either format's content. |
| `wb_scene_render` | Vector image (`.svg`) | Rendered from the document's spatial layout (canvas-render's scene graph + SVG backend) — shapes, laid-out Markdown text, and routed edges. A canvas's comments (pins, cards, region outlines, highlighted passages) are left out unless the call passes `comments: true`. |

**The format is not a parameter.** `wb_document_get` answers in whatever
format the document is in, and says which in its `kind` field; there is no
"read this diagram as Markdown". SVG is the one cross-format output, and it is
an explicitly lossy projection rather than a way to read the stored content
(see [ADR-0009](../contributing/adr/0009-mcp-tool-naming.md)).

**The daemon does not typeset math or draw diagrams.** `wb_scene_render`, the
daemon's `POST …/export` and the `canvas_view` widget draw a `$$` math block as
its TeX source as text, and a `` ```mermaid `` fence as a plain code
block. Inline `$…$` math is drawn as its source text everywhere, the web app
included. Fenced code blocks are syntax-coloured for the languages the layout
knows (the note preview, the daemon's renders and the exports alike), in the
light or dark palette of the surface they are drawn on. Footnotes are not
supported: `[^1]` stays in the text as written and its `[^1]: …` definition
is drawn as an ordinary paragraph where it was written. In the web app, the note preview, the canvas editor, a past version
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
header. An SVG image that asks for filter effects (a `<filter>`, a filter
primitive, or a `filter` attribute or style), uses a mask (a `<mask>`, or a
`mask` attribute, or a `mask` or `mask-*` style), declares an XML entity, or
holds an image of its own also draws nothing in a PNG: the time or memory its
drawing takes is not bounded by its size. Any other image draws nothing.

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
  piece, before applying it, and the same for an update of several separate
  inserts that together cost more to apply than one of that size: the cost of
  an insert grows with the square of its length, so two inserts of 200,000
  characters are refused while any number of the short inserts an editor
  sends are not. A promoted workspace is judged by its whole
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
  `nodes`). The workspace document's `update` and `promote` refuse it too, for
  an update or record that leaves a document's content container key
  (`nodes`, `body`, `threads` and the others) holding a plain value, a
  container of another kind, or nothing. A document's `update` and the
  workspace document's `update` and `promote` refuse, with
  `400 {"error":"document_kind_changed"}`, an update or record that leaves a
  document's envelope `kind` saying anything other than the kind its
  workspace node records; setting it on an unkinded document to that same
  kind is how a keeper claims one, and lands. A document's `update` and the
  workspace document's `update` and `promote` refuse, with
  `400 {"error":"reserved_map_key"}`, an update or record that writes a key
  named `__proto__` — a map entry, a root container, or a key inside a stored
  value; deleting one a record already holds lands. The workspace document's `update` also refuses, with
  `400 {"error":"document_name_too_long"}`, an update that gives a document a
  name longer than 200 characters. A name stored longer before that bound can
  still be kept or shortened. It refuses, with
  `400 {"error":"folder_name_refused"}`, an update that gives a folder a name
  that is blank, holds a `/` or is longer than 200 characters; a folder name
  stored before can still be kept or repaired. The workspace document's `update` and `promote`
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
  would pass it, in the browser and on the daemon alike — and on the daemon
  by a document's `update` to a path no document holds yet and by a version
  restored to a new path, whose missing parent folders count the same way.
  A workspace already
  holding more still lists, and still takes a write that adds no folder.
  A sync `update` also refuses, with
  `409 {"error":"causal_gap"}` and nothing stored, an update that builds on a
  change the daemon does not hold; the web app sends it again, and it lands
  once the daemon holds what it builds on. The same answer refuses an update
  or a promoted record holding writes into a container created by a change
  those writes do not build on.
- **Rewriting references** is held to the same ceilings, the 262,144
  characters of a body and the 8,192 of a text node. Each link is longer than
  the name it replaces, and a moved document's new path can be longer than
  its old one, so either rewrite can grow a text. Link mentions (the
  Linked from panel's Link, `POST /api/v1/workspaces/{id}/documents/{documentId}/linkify-mentions`)
  that would carry the body or a node past its ceiling write nothing: the
  route answers `413` with `{"error":"markdown_too_large"}` or
  `{"error":"node_text_too_large"}`, and the mention stays listed. When a move
  follows references, a document the new path would carry past a ceiling is
  left as written, with its references still naming the old path, in the
  browser and on the daemon alike. The daemon reports it among the documents
  the move could not rewrite: in `wb_workspace_edit`'s
  `follow.failedDocumentIds`, or its log for the rename route. The move
  itself stands.

### How deeply markdown may nest

Markdown nests one level per marker: each `>` opens a blockquote, each `- `
on a line opens a list, each `*` an emphasis. Rendering (`wb_scene_render`,
the web preview, a text node drawn on a canvas) reads at most **64 levels**
of that nesting, counting the paragraph that holds the words. Anything deeper
is drawn as the plain text it contains, with its markers gone: `*` repeated
300 times on each side of `x` draws 62 nested bold spans around `x`. The
parser itself opens at most **32** nested quotes and lists: a `>` or a list
marker past the thirty-second is ordinary text, so `>` repeated 50 times
before `x` draws 32 nested quotes around a paragraph holding eighteen `>`
characters and `x`. A body that still nests deeper than the parser can follow
is drawn as one paragraph of its own source text. The stored body is never
changed; only what is drawn from it is.

### Markdown that would take too long to read

A few markdown shapes cost the parser time that grows with the square of
their length, so a body far inside the size limit could hold rendering for
minutes. Each is bounded, and only a body built to hit the bound reads
differently:

- **Emphasis, strikethrough and link ends.** One paragraph, heading or table
  cell hands at most **1,024** `*`, `_`, `~` and `]` characters to emphasis,
  strikethrough and link resolution; the rest of it shows them as the
  characters they are. That is 256 bold phrases in one paragraph. An `_`
  inside a word, as in `snake_case`, never counts.
- **Literal links.** A bare `www.` or `http://` address links at most
  **2,048** characters of path; past that the link ends and the rest is text.
  Of more than 256 punctuation marks closing an address, all but the last 256
  are part of the link.

A blank line between paragraphs gives each its own allowance, so splitting
the text is enough to have all of it read.

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
each occurrence, so their length is paid once per occurrence. Only the
**1,024 occurrences** nearest where the passage last was are compared: a
passage quoted that often is placed among those, and one further away is
not considered. `wb_thread_edit`
refuses a longer one on `thread.add`, and `wb_body_edit` on `body.replace`,
with "a text anchor's context is longer than the 32-character limit"; keep the
characters nearest the passage. The editor writes 16. An anchor stored with a
longer context still reads, and only its 32 characters nearest the passage
count toward placing it.

The quoted passage itself — a text anchor's `exact` — carries at most **1,024
characters**, a long paragraph. Every place that draws a passage finds it
again after each edit, resolved threads and decided changes included, and the
cost grows with the quote. `wb_thread_edit` refuses a longer one on
`thread.add`, and `wb_body_edit` on `body.replace`, with "a text anchor's
quote is longer than the 1024-character limit for the passage one anchor
quotes"; anchor a comment to a shorter passage, and split a longer
replacement across changes. The daemon's sync routes refuse an update that
would store one with `413` and `{"error":"anchor_quote_too_long"}`, storing
nothing, and a browser-kept workspace refuses it the same way. Commenting in
the editor on a selection or a block longer than that anchors the
conversation to its first 1,024 characters. An anchor stored with a longer
quote before this limit existed still reads, and a verdict on such a change
is still taken.

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

A folder can carry a display name of its own, kept apart from its path the
way a document's is: naming a folder moves nothing, and the folder keeps the
path it was made with. A folder name holds the same 200-character bound, and
may not be blank or contain `/`, which is what separates folders in a path.
It is written by `wb_workspace_edit`'s `folder.rename` op and by
`PUT /api/workspaces/{id}/folders/name` with `{"path": …, "name": …}` (no
`name` clears it), and `GET /api/workspaces/{id}/documents` lists it as
`folderNames: [{"path", "name"}]` beside `documents` when any folder is
named. The name travels with the folder when it moves, and goes with it
when the folder empties and is removed. Only a folder can be named: the
path of a document that has documents below it is a document, not a folder,
and naming it answers `404`.

Two documents in the same folder may not show the same name, and neither
may two folders in the same folder. A create, a rename, or a markdown
document's frontmatter `title` that would give a document the name another
document beside it already shows — its name, or its last path segment when
it has none — is refused, and so is a folder name another folder beside it
shows; names are compared ignoring case, surrounding spaces and Unicode
composition, so `Week 6`, ` week 6 ` and `WEEK 6` are one name. The refusal
answers `409 {"error":"display_name_taken"}` from `/api/v1` and the daemon's
name routes, and stops a `wb_workspace_edit` batch at that op. A folder and a
document may share a name, and so may two documents in different folders.
Two names that only meet when two copies of a workspace merge — each named
while the other could not see it — are both kept: nothing renames either,
and either can keep its own name in a later write.

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

Within those bounds, one render also caps the work two parts of edge routing
may do, because each can grow far faster than the board: the search that
finds a way around boxes when no simple route is clear, and the search that
picks which side of a box each edge leaves from and arrives at. A board built
to defeat either — hundreds of edges through 64 bends each over one square, or
a box walled in behind a curtain of thin boxes — took from minutes to a
quarter of an hour to render without the cap, and with it renders in about
the time an ordinary board of its size does. The largest ordinary boards the
project tests spend under a quarter of either allowance and render exactly
as they would without it. A board that does exhaust one still draws every
edge: past it, an edge no simple route reaches keeps its simple route even
where that runs through a box, and the side choice stops improving on the
sides it has reached.

The daemon's sync routes — a document's `update`, the workspace document's
`update` and `promote` — refuse an update that grows a board past either bound
with `413` and `{"error":"too_many_nodes_or_edges"}` (the code covers lines
too), storing nothing; `promote` names the canvas. A browser-kept workspace
refuses the same change the way it refuses an over-long node: nothing is
saved, the page goes back to what is stored, and the notice says why. A board
stored past a bound before it existed still reads, and still takes any change
that leaves it no larger — moving, restyling, or replacing one node with
another — so removing nodes, edges or lines is how it shrinks.

Line jumps (`lineJumps: "arc"`) draw at most **64 hops on one segment** and
**4,096 on one board**; a crossing past either cap is drawn as a plain
crossing, without its arc. Finding crossings has its own bound too: past
**4,000,000 candidate pairs** examined on one board, the search stops and no
further hops are drawn, while the hops already found are kept — so a board of
long, nearly parallel edges that never cross cannot make a render search
indefinitely. Edges and lines are searched in the order they are drawn. The
later edge hops over the earlier one; where it has no straight run to carry the
arc (the crossing falls on one of its bends) the earlier edge hops instead.

## How much referenced content one render loads

When `wb_scene_render` draws with `embedReferences`, and whenever `canvas_view`
answers, the server loads what the document points at — file nodes, `[[…]]`
links and `![[…]]` embeds, and what those documents name in turn — up to
**256 references**. A document named more than one way, by its id and by its
path, is read once and answers both.

The content those references load is bounded too: at most **1,048,576
characters** (four documents at the 262,144-character limit), counting a note's
body and the text of a board's nodes, and at most **4,000 nodes, edges and
lines** across the referenced boards — one maximal board's worth, which is as
much as a render draws nested anyway. References are loaded in the order the
document names them, and the first document that would go past either bound,
and every document not already loaded after it, is drawn by its name alone: a
file node shows its card, an embed its placeholder, and `canvas_view` sends
that reference with its id and name but no body or canvas. A later reference
to a document loaded before the bound was reached still answers with its
content, since it costs nothing more to read.

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

One comment thread holds at most **1,000** messages, resolved thread or not:
every reader of a thread — `wb_thread_edit`'s answer, `wb_document_get`, the
comments rail — reads all of them. `wb_thread_edit`'s `message.add` refuses
the reply that would pass it — "thread "t1" would hold 1001 messages, past
the limit of 1000 messages in one comment thread; open a new thread to
continue" — and writes nothing; a sync update is refused with `413` and
`{"error":"too_many_thread_messages"}`, storing nothing, by either keeper. A
thread already holding more than that still reads, and a message it holds can
still be edited, but it takes no further reply.

A comment anchored to several nodes at once names at most **2,000** of them —
a whole canvas's worth. Every render looks each named node up, resolved
threads included, so this is held whether the thread is open or not.
`wb_thread_edit` refuses a `thread.add` naming more ("a node set names more
nodes than the 2000-node limit for one comment anchor, a whole canvas's
worth"), and the daemon's sync routes refuse an update that would leave an
anchor naming more with `413` and `{"error":"comment_anchor_too_large"}`,
storing nothing. A thread stored with a larger set before this limit existed
is left out when the document is read; the document and its other threads
read as before.

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

A batch also places at most **2,000** nodes inside groups between all of its
ops — every member a `region.set` moves in, and every `node.add` with `within`
and no position. Each is packed around what its group already holds, so a
batch moving the same members back and forth between two groups would pay
for that packing once per op. The op that would pass the bound is refused
with "a batch places at most 2000 nodes inside groups", and nothing is
written; move the rest in another call.

Its `node.patch` ops patch at most **2,000** nodes between them, counting
every node an `all` or `within` selector reaches. A patch that changes text
or size measures each node it reaches, so a batch of selector-wide patches
would measure the whole board once per op. The op that would pass the bound
is refused with "a batch patches at most 2000 nodes between its node.patch
ops", and nothing is written; put the fields in one `node.patch`, or patch
the rest in another call.

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

**YAML anchors and aliases are refused.** A frontmatter that marks a value
with `&name` or repeats one with `*name` (a `<<:` merge key included) is not
stored: a `document.set` or `document.create` op and `POST
/api/v1/workspaces/{id}/documents` answer "YAML anchors and aliases are not
allowed in OKF frontmatter". OKF gives them no meaning, and an
alias makes a few bytes stand for a value of any size. Write the value out
each time it is needed; this server writes a repeated value out in full too.

**Frontmatter nests at most 32 levels.** The root mapping is one level, and
every mapping or list inside it one more. A deeper frontmatter is not stored:
the same write paths answer "OKF frontmatter may nest at most 32 levels of
mappings and lists". Each level is written two spaces further in, so a value
nested hundreds deep exports as hundreds of times its size. A document stored
with deeper frontmatter before this limit still reads and exports in full; it
is re-importing that export which is refused.

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

A board whose boxes or edges carry scoped tags exports with its **legend** under the
drawing, at its left edge, whenever the board's colours follow a key, exactly as the editor
shows it (see
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

Glow halos and comment drop shadows have a budget of their own, because a renderer blurs
the whole area each one covers: about **8 megapixels** of halo, counted at the export's
`scale` and only inside the picture, with a shadow's area counting twice. A board past it
is not refused; it is drawn with the LARGEST halos and shadows left off until the rest fit, and
every node, edge, label and comment is still drawn. An ordinary board stays well inside it —
a 150-node `visual.neon` board uses about 6 — but the boards that pass it are the ones whose
halos are largest: edges that cross the whole board, nodes the size of the board, and stacks of
long comments. A higher `scale` spends the budget faster, since a 2x PNG has four times the pixels
under each halo. SVG export, `wb_scene_render` and the web app's export apply the same
budget at 1x.

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

A picture is filled with the light palette's surface (white) by default, as a
`<rect>` covering the whole viewBox drawn before anything else, so a PNG is
opaque and an SVG dropped onto a dark slide still reads. The **With background**
checkbox in the Export… submenu turns the fill off, and the file is then
transparent, byte for byte what an export without the option draws. The **2×
resolution (PNG)** checkbox rasterises a PNG at twice the pixels in each
direction with the same drawing (the viewBox is unchanged); an SVG ignores it.
Both are remembered per browser and apply to all four picture entries. The
daemon's `wb_scene_render` and `POST …/export` do not read these checkboxes; the
PNG route keeps its own `scale` parameter.

The export draws what the editor shows, including what the document points at:

- **A canvas** exports with its pictures, the note or board a file node points
  at, and what a text node embeds with `![[…]]`. The comment layer — pins, cards,
  region outlines and the highlights of threads about a passage — is left out of
  Export as PNG / SVG and drawn by Export as PNG (with comments) / SVG (with
  comments). A file node pointing at another board draws its
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
instead of carrying it, as `Roboto, system-ui, sans-serif` — a viewer with Roboto
renders it identically, and one without it falls back to its system sans-serif face
(rather than a serif one) and gets a smaller file.

**Save as Markdown (.md)** (More actions → Export…, on a markdown note) downloads
the note as OKF Markdown: its frontmatter — `type`, tags, facets — and its body.
The document's name is written as the frontmatter `title`, a projection of the
workspace's display name, so a document with no name writes none. **Save as JSON Canvas
(.canvas)** (on a canvas) downloads the extended-mode JSON Canvas document. Both are the
document's own source rather than a picture. An image on a canvas is saved as an
`asset:` reference to the workspace's file, not as its pixels, so the notice says
"images are referenced, not embedded" when the canvas has one; the picture exports above
are the ones that carry the pixels.

**Import** reads the same two sources back: `.md`/`.markdown` through the OKF parser
(frontmatter optional) and `.canvas`/`.json` through the JSON Canvas parser, creating one
document per file; see [Export and import a document](../how-to/export-and-import-a-document.md#bring-a-file-in).

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
