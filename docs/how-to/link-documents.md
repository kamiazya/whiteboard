# Link documents and see what links back

Connect documents to each other, and read those connections from the other
side. Works against a daemon-backed workspace.

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

Write `![[path]]` (or `![[<document id>]]`) on a line of its own to show
the target *inside* this document instead of linking out to it:

- A **markdown** target renders its body inline, as if the text were
  written here. Embeds nest, three levels deep; a document that embeds
  itself, directly or through another, shows a placeholder at the point
  the loop closes.
- A **canvas** target renders as a framed miniature of the whole canvas,
  scaled to the column, under its display name. The name is a link that
  opens the canvas. File nodes inside the miniature keep their card form;
  only the canvas you open expands them.

An `![[...]]` mixed into a sentence behaves like a `[[...]]` link labelled
with the target's name. An embed counts as a link for the Connections chip
below, so the embedded document lists this one as linking to it.

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
