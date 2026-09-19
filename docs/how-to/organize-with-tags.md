# Organize documents with tags

Tags written in a markdown document's properties become searchable and
filterable in the document browser. A board, a box and an edge take tags
too, from the editor's panels.

## Add tags

Open a markdown document, open its properties (the info button beside the
title), and add tags. Tags are OKF frontmatter — they travel with the
document on export.

On a board, tag a box or an edge from its Facets panel: right-click it and
choose **Facets…**; the **Tags** row sits under the visual style. The
board's own tags are in the Display settings, under the theme.

Every tag row works the same way: type a tag and press Enter or a comma to
finish it, and press a chip's × to remove it. A tag is either a plain word
(`draft`) or a **scoped** `key:value` pair (`health:failing`), and the box
offers what the board and the rest of the workspace already use — the keys
before you type a colon, the values under that key after it. A tag with a colon that is not `key:value`
(`Health:OK`) is refused with the rule; correct it and finish again.

With several boxes selected, a tag added or removed on one is added or
removed on all of them; what each box already carried stays.

## Read the legend

When a board's colours follow a scoped key — every `health:ok` box green,
every `health:failing` box red — a **legend** appears in the board's
top-left corner listing that key's values with the swatch each is drawn
in, boxes and edges each in their own kind of swatch. It is part of the
board, so an SVG or PNG export carries it too; in the editor it collapses
to its title. When colour is used but no key explains it, the legend says
so in one line instead of guessing.

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
  on the board, in an SVG or PNG export, and by `wb_scene_render` — so the
  legend lists the key because the library said so rather than because
  someone coloured every box by hand. A colour set on the box itself always
  wins, and a box carrying two declared colours under two keys gets
  neither. The board reads the library when it opens; after editing the
  `tags` document, reopen the board to see the change.
- **The declaration is discoverable.** `wb_facet_list` with a
  `workspaceId` answers the library under `tagLibrary` beside the tags in
  use, so an agent can read the vocabulary it will be held to.

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
