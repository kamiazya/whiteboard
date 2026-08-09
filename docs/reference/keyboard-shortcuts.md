# Keyboard shortcuts

Every shortcut below works on the spatial canvas editor. `Cmd` is the macOS
modifier; use `Ctrl` everywhere else — both satisfy the same binding.

Two rules hold for the whole table:

- **Every shortcut has a pointer path too.** Anything you can do with the
  keyboard is also reachable from an object's right-click menu, the
  empty-space menu, or the bottom dock — a shortcut is an accelerator,
  never the only way in.
- **Shortcuts never fire while you are typing.** Inside a node's text
  editor or a dialog field, the keys belong to the text.

## Tools

| Shortcut | Action |
|---|---|
| — | Hand (pan) — the tool a canvas opens in; drag anywhere to pan |
| — | Select — click to select, drag to marquee |
| — | Connect — click one node, then another, to draw an edge |
| `Space` + drag | Pan from any tool, without leaving it |

The three tools live in the bottom dock. On touch, two-finger drag pans and
pinch zooms in every tool.

## Selection and editing

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + A` | Select every node |
| `Shift` + click | Add or remove a node from the selection |
| Arrow keys | Nudge the whole selection (`Shift` for a larger step) |
| `Delete` / `Backspace` | Delete the selected nodes, or the selected edge |
| Double-click | Edit a node's text, an edge's label, or a group's label |
| `Cmd/Ctrl + Shift + L` | Lock or unlock the selection |
| `Esc` | Cancel the current gesture or clear the selection |

A locked node or edge cannot be selected, moved, restyled, or deleted, and
MCP tools refuse to patch it too. Right-click it and choose **Unlock** to
release it. Nodes and edges lock independently: locking a node does not
lock the edges attached to it, and an edge between two locked nodes stays
editable until you lock the edge itself. The lock is editor state — it is
stored alongside the canvas but never appears in an export.

## Clipboard

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + C` | Copy the selection |
| `Cmd/Ctrl + X` | Cut the selection |
| `Cmd/Ctrl + V` | Paste |
| `Cmd/Ctrl + D` | Duplicate the selection in place |

Copy puts the selection on your system clipboard as JSON, so a paste works
in another canvas, another tab, or after a reload. Pasting content from
elsewhere follows what it finds: an image becomes an image node, our own
copied JSON becomes the nodes it describes, and any other text becomes a
note. Edges come along whenever both of their endpoints are selected.

Right-click empty space and choose **Paste here** to place the pasted
content at that exact point instead of the default offset.

## Arranging

| Shortcut | Action |
|---|---|
| `]` | Bring forward |
| `[` | Send backward |
| `Shift + ]` | Bring to front |
| `Shift + [` | Send to back |

Forward and backward step over the nearest node the selection actually
overlaps — stepping past something you do not overlap would change nothing
on screen. The same four moves sit in a node's right-click menu under
**Order**.

## Viewport

| Shortcut | Action |
|---|---|
| `Shift + 1` | Zoom to fit all content |
| `Shift + 2` | Zoom to the selection |
| `Cmd/Ctrl` + scroll | Zoom under the pointer |
| Scroll / two-finger drag | Pan |

In Hand mode the dock shows zoom out, the current zoom (click to reset to
100%), zoom in, and zoom to fit.

## History

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + Z` | Undo |
| `Cmd/Ctrl + Shift + Z` | Redo |
| `Cmd/Ctrl + S` | Save a version |

One action is one undo step: pasting twenty nodes, duplicating a
selection, or nudging several nodes each undo in a single press.

← Back to [reference](README.md)
