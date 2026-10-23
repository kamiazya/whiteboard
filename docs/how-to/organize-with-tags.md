# Organize documents with tags

Tags written in a markdown document's properties become searchable and
filterable in the document browser. A board, a box and an edge take tags
too, from the editor's panels.

## Add tags

Open a markdown document, open its properties (the info button beside the
title), and add tags. Tags are OKF frontmatter — they travel with the
document on export.

On a board, tag a box or an edge from its Facets panel: right-click it and
choose **Facets…**, or select it and open **Display**, where the selection's
facets lead the panel; the **Tags** row sits under the visual style. The
board's own tags are in the Display settings, below the selection's, under the
theme.

Every tag row works the same way: type a tag and press Enter or a comma to
finish it, and press a chip's × to remove it. A tag is either a plain word
(`draft`) or a **scoped** `key:value` pair (`health:failing`), and the box
offers what the board and the rest of the workspace already use — the keys
before you type a colon, the values under that key after it. A tag with a colon that is not `key:value`
(`Health:OK`) is refused with the rule; correct it and finish again.

The same rule holds when an agent writes a document's whole markdown body:
`wb_workspace_edit`'s `document.set` and `document.create` ops (and
`POST /api/v1/workspaces/:workspaceId/documents`) refuse a frontmatter tag such
as `Health:OK` or `a:b:c` with the rule, and write nothing. Plain tags
(`Machine Learning`, `v1.2`) pass. A document that already carries such a tag
— imported from another tool, say — still opens and keeps it; it is replaced
only through a write that no longer carries it.

With several boxes selected, a tag added or removed on one is added or
removed on all of them; what each box already carried stays.

## Read the legend

When a board's colours follow a scoped key — every `health:ok` box green,
every `health:failing` box red — a **legend** appears in the board's
top-left corner listing that key's values with the swatch each is drawn
in, boxes and edges each in their own kind of swatch. It is part of the
board, so an SVG or PNG export carries it too; in the editor it collapses
to its title. A board whose colours follow no key has no legend: colour
you chose by hand is yours, and nothing is drawn to say a key does not
explain it. When the legend is there and some other colour is not
explained by a key, one muted line says so.

## Declare the vocabulary

A workspace can say up front which keys exist, which values a key admits,
what colour each value is drawn in, and whether a key is **one value at a
time**. That declaration is a **tag library**: an ordinary markdown
document at the path `tags` carrying the `visual.tags/v0` facet, the same
shape as the [stencil library](define-your-own-stencils.md#growing-the-vocabulary).
It is written through the MCP server — one `wb_facet_set` call on that
document:

```json
{
  "workspaceId": "…",
  "documentIds": ["<the document at tags>"],
  "facets": {
    "visual.tags/v0": {
      "keys": {
        "health": {
          "description": "Whether the component is serving",
          "exclusive": true,
          "values": {
            "ok": { "color": "4" },
            "degraded": { "color": "3" },
            "failing": { "color": "1" }
          }
        },
        "region": { "exclusive": true, "values": { "eu": {}, "us": {} } },
        "phase": {}
      }
    }
  }
}
```

A key with no `values` admits any value; a key with `values` admits only
those. A key that is not `exclusive` may carry several values on one object
(`region:eu` and `region:us` together), which is the default.

What the library changes:

- **A write outside it is refused before anything is written.** Tagging a
  box `health:unknown`, or adding `region:us` to a box already carrying
  `region:eu` under an exclusive key, is refused by `wb_facet_set` with the
  admitted values in the message, and a batch refused on one document has
  written nothing to the others. A document whose markdown body declares
  such a tag in its own properties is refused the same way — when it is
  created and when it is replaced — and a refused create leaves no document
  behind. Every tag row in the editor refuses the same tag by the same rule,
  and keeps what you typed so you can fix it.

  One write is not held to it: what the editor syncs as you type. A sync
  message carries the document's state rather than a request to change it,
  so there is nothing there to refuse; the row you type into is where that
  write is checked.
- **The rows complete from the declaration.** Under a declared key, a tag
  row offers the admitted values beside whatever the workspace already
  uses, on notes, boards, boxes and edges alike.
- **Colour by intent.** A box or an edge that carries a value with a
  declared colour, and has no colour of its own, is drawn in that colour —
  on the board, in the minimap, in a past version's preview, in the
  document browser's cards, its preview pane and Peek, in an SVG or
  PNG export, by `wb_scene_render`, and in the inline view `canvas_view`
  shows in chat — so the legend lists the key because the library said so
  rather than because someone coloured every box by hand. A board drawn
  INSIDE another document is coloured the same way: a file node's
  miniature, a `![[board]]` embed in a note or a text node — on the
  canvas, in the note's preview, and in the document browser's cards,
  preview pane and Peek — and the cached copy you read while the daemon is
  unreachable. Its legend stays with the
  board itself; the miniature carries the colours only. A colour set on the
  box itself always wins, and a box carrying two declared colours under two keys gets
  neither. The board reads the library when it opens, and the document
  browser when it is shown; after editing the `tags` document, reopen the
  board, or return to the browser, to see the change.
- **The declaration is discoverable.** `wb_facet_list` with a
  `workspaceId` answers the library under `tagLibrary` beside the tags in
  use, so an agent can read the vocabulary it will be held to.

## Colour a tag

In a browser-kept workspace, a tag can be coloured without writing the
library by hand. In the **Display** panel's **Tags** row (and the same row
in a note's header), open a `key:value` chip's menu and choose **Set
colour…**, then one of the six swatches the box colour row uses, or **No
colour** to take the colour back. The colour is written into the workspace's
tag library, so every box or edge carrying that tag and no colour of its own
is drawn in it, and the legend lists the key — a colour you set on a box with
a swatch stays yours and is never explained by a key, which is why it gets no
legend.

A few things worth knowing:

- Only `key:value` tags have a menu; a plain tag has nowhere in the library
  to be coloured.
- The first colour on a key that declared no values gives that key a list of
  admitted values — the one you coloured and every value the workspace already
  carries under it. A key with values refuses others, so a new value under it
  is then refused until it is added to the library.
- The legend appears when the key tells boxes apart by colour: colouring
  `tier:service` while a box tagged `tier:database` stays uncoloured lists
  both; colouring the only value on the board lists nothing. The keys `frame`,
  `kind` and `stencil` are the board's own distinctions, so a tag under one of
  them is drawn in its colour but never listed.
- The colour is an edit to the `tags` document, not to the board you are on:
  it does not join the board's undo. **No colour** reverses it.
- A workspace the daemon keeps cannot be coloured this way yet; the menu is
  not offered there. Write the library with `wb_facet_set` as above.

## Find by tag

In the document browser:

- The **tag strip** above the file panes lists every tag in use anywhere in
  the workspace — on notes, boards, boxes and edges — plain tags first, then
  each scoped key with its values under it (`health` · ok · failing), each
  with a count of what carries it (hover for the breakdown). Click one to
  filter to the documents carrying it; click it again to clear.
- The **search box** understands two forms: plain text matches tags along
  with names and paths, and `#tag` matches *only* documents carrying exactly
  that tag.
- Document cards and search results show each document's tags.

A board's own tags show in the document browser under either keeper. What
a board's boxes and edges carry is counted on the strip but is never a
document tag: filtering by such a tag finds the boards whose boxes carry
it, and the MCP search (`wb_document_search`) names the matching boxes.
