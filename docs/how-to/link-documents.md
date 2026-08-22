# Link documents and see what links back

Connect documents to each other, and read those connections from the other
side. Works against a daemon-backed workspace.

## Write a link

In a **markdown document**, type `[[` — a completion list of the
workspace's documents opens as you type, ranked by match; Enter inserts the
link. The toolbar's Link action offers the same list as a dialog (and also
handles external URLs). A reference can name its target three ways:

- `[[<document id>]]` — survives renames and moves; what the link picker
  inserts when names are ambiguous.
- `[[Display name]]` — resolves while exactly **one** document carries that
  name. If a second document takes the same name, the link stops resolving
  and renders as literal bracket text until the collision is undone.
- `[[path]]` — resolves the document's current path the same way.

On a **canvas**, a document embedded through the palette's Document entry,
a file node pointing at a document path, and a `[[...]]` inside a text node
all count as references too.

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
`[[...]]` links in one server-side operation — the readable `[[Name]]`
when the name is unique, `[[<id>|Name]]` otherwise. Mentions inside canvas
labels are listed but never rewritten (a link in a label would render as
literal brackets). The system still never links without a click — a link
is the author's claim.

## Rules worth knowing

- A link that does not resolve for the *reader* (an ambiguous name, an
  unknown target) never appears as a connection either — the two surfaces
  always agree.
- Deleting a document removes its outgoing references immediately.
- Renaming a document breaks inbound `[[path]]` / `[[Display name]]` links
  that used the old spelling, but never `[[<document id>]]` links.
