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
offers what the board already uses — the keys before you type a colon, the
values under that key after it. A tag with a colon that is not `key:value`
(`Health:OK`) is refused with the rule; correct it and finish again.

With several boxes selected, a tag added or removed on one is added or
removed on all of them; what each box already carried stays.

## Find by tag

In the document browser:

- The **tag strip** above the file panes lists every tag in the workspace.
  Click one to filter to its documents; click it again to clear.
- The **search box** understands two forms: plain text matches tags along
  with names and paths, and `#tag` matches *only* documents carrying exactly
  that tag.
- Document cards and search results show each document's tags.

A board's own tags show in the document browser when the workspace is kept
by the daemon; a board kept in the browser is tagged and exported the same
way, but the browser's document list does not read them yet. What a
board's boxes and edges carry is never a document tag: it is found through
the MCP search (`wb_document_search`), which names the matching boxes.
