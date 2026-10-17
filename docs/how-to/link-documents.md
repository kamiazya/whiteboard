# Link documents and see what links back

Connect documents to each other, and read those connections from the other
side. Works the same whether the browser or the daemon keeps the workspace.

## Write a link

In a **markdown document**, type `[[` — a completion list of the
workspace's documents opens as you type, ranked by match; Enter inserts the
link. The toolbar's Link action offers the same list as a dialog (and also
handles external URLs). A reference can name its target two ways:

- `[[path]]` — what the picker and completion insert. The link is shown
  with the target's **current display name**, so it always reads naturally,
  and moving the document rewrites references to the old path for you.
- `[[<document id>]]` — survives everything; what the picker inserts for
  the rare path that could be mistaken for an id.

Write `[[path|your own words]]` when the link should read as something
other than the target's name. A `[[Display name]]` is **not** a link — it
stays literal bracket text; display names label links at render time
instead of addressing them.

On a **canvas**, a document embedded through the palette's Document entry,
a file node pointing at a document path, and a `[[...]]` inside a text node
all count as references too.

## Embed a document

Write `![[path]]` on a line of its own to show the target *inside* this
document instead of linking out to it. The `[[` completion works here too,
so type `![[` and pick the document:

- A **markdown** target renders its body inline, as if the text were
  written here. Embeds nest, three levels deep; a document that embeds
  itself, directly or through another, shows a placeholder at the point
  the loop closes. One view draws at most 128 embedded documents in all,
  counting canvas miniatures and file-node previews; past that, an embed
  shows its placeholder and a file node its card.
- A **canvas** target renders as a framed miniature of the whole canvas,
  scaled to the column, under its display name. The name is a link that
  opens the canvas. File nodes inside the miniature keep their card form;
  only the canvas you open expands them.

An `![[...]]` mixed into a sentence behaves like a `[[...]]` link labelled
with the target's name. An embed counts as a link for the Connections chip
below, so the embedded document lists this one as linking to it.

### Embed part of a document

Add `#` and a name to point inside the target:

- `![[notes/plan#Launch]]` embeds the **section** under the heading
  "Launch" — the heading and everything up to the next heading of the same
  or a higher level.
- `![[boards/roadmap#Launch]]` embeds the **group** labelled "Launch" on
  that canvas: the group's frame, the nodes inside it, and the edges
  between them. Give a group a label to make it addressable this way.

The match is by text, exact first and then ignoring case; when two headings
or groups share a name, the first one on the page wins. A part that does
not exist shows the address as a link and nothing else. The same `#` works
on a plain `[[path#Launch]]` link, which then reads as `Plan › Launch`.

## Follow a link

Click a `[[...]]` link — or the link an `![[...]]` embed shows — to open that
document in place. This works in the markdown editor's preview and on a
canvas, for a link drawn inside a text node.

In the workspace index, a link in the selected document's preview, or in
Peek, opens that document the same way. Links inside a file card's picture
and in a version preview do nothing when clicked.

The cached copy you read while the daemon is unreachable follows links the
same way: a link in a note or on a canvas, or a file node you double-click,
opens the linked document from that copy, in place. A link to a document the
copy does not hold does nothing.

A followed link opens the document at its top; a `#` part names what the link
points at but does not scroll to it.

A document link never makes the browser navigate away. Ordinary links (a web
address, or a relative path such as `guide.md`) keep the browser's usual
behaviour.

In the inline chat view (`canvas_view`), document links do nothing; see
[View a canvas inline in your AI chat](view-canvas-in-chat.md#links-in-the-view).

## See what links back

Every document's header carries a Connections chip (the waypoints icon)
showing how many documents link here. Click it to open the list — each
entry shows the linking document and a snippet of the text around the
reference (or the canvas relationship). Click an entry to jump to it.

The chip shows `0` on a document nothing links to yet; links written
anywhere in the workspace land here automatically.

Below the linked-from list, **Mentioned, not linked** surfaces documents
whose prose contains this document's display name without linking to it —
candidates for a link the author never wrote. Click a row to open it and
decide, or **Link it** to convert that document's mentions into real
`[[...]]` links in one server-side operation — written as
`[[path|Name]]`, so the prose keeps reading as the name. Mentions inside canvas
labels are listed but never rewritten (a link in a label would render as
literal brackets). The system still never links without a click — a link
is the author's claim.

## Rules worth knowing

- A link that does not resolve for the *reader* (an unknown target, a
  bracketed display name) never appears as a connection either — the two
  surfaces always agree.
- Deleting a document removes its outgoing references immediately.
- Moving a document rewrites inbound `[[path]]` links to the new path.
  Renaming (the display name) changes what links *show*, never what they
  mean. `[[<document id>]]` links survive everything.
