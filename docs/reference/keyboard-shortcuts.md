# Keyboard shortcuts

Every shortcut below works on the spatial canvas editor. `Cmd` is the macOS
modifier; use `Ctrl` everywhere else — both satisfy the same binding.

Two rules hold for the whole table:

- **Every shortcut has a pointer path too.** Anything you can do with the
  keyboard is also reachable from an object's right-click menu, the
  empty-space menu, or the bottom dock — a shortcut is an accelerator,
  never the only way in.
- **Shortcuts never fire while you are typing.** Inside a node's text
  editor or a dialog field, the keys belong to the text — except
  `Cmd/Ctrl + Enter`, whose whole job is to save what you typed.

## Tools

| Shortcut | Action |
|---|---|
| `H` | Hand (pan) — drag anywhere to pan. A canvas with content opens in Hand, an empty one in Select, and a canvas you have used before in this browser session reopens in whichever of the two you last chose on it |
| `V` | Select — click to select, drag to marquee |
| `C` | Connect — click one node, then another, to draw an edge |
| `D` | Draw — drag across the board to leave a freehand stroke |
| `N` | Add a note at the centre of the view |
| `Space` + drag | Pan from any tool, without leaving it |

The four tools live in the bottom dock, and their letters show in its tooltips. The letters work from any tool and never while you are typing; with `Cmd/Ctrl` held, `C` and `D` stay copy and duplicate. On touch, two-finger drag pans and
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
| `Cmd/Ctrl + Enter` | Save the text you are editing and close the editor |
| `Esc` | Cancel the current gesture; in a text edit, discard what you typed |

**Align and distribute** have no shortcut — they live in the right-click
menu of a multi-node selection, as **Align** (six edges and centre lines)
and **Distribute** (horizontal, vertical). Align appears once two nodes are
selected; distribute once there are three, because it repositions the
middle ones and leaves the outermost two anchoring the span. Both align to
the selection's own bounding box, so the result does not depend on which
node you clicked first, and each is a single undo step.

A locked node shows a small padlock in its top-right corner so you can tell it
from one that is simply unresponsive; the padlock appears in the editor only
and never in an export. A locked node or edge cannot be selected, moved, restyled, or deleted, and
MCP tools refuse to patch, tag, or set facets on it too. Right-click it and choose **Unlock** to
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
| `+` / `-` | Zoom in or out one step, about the middle of the view |
| `Cmd/Ctrl` + scroll | Zoom under the pointer |

The view is not remembered between visits. A canvas opens at the origin, and
when none of its content is in view there it opens framed on the content, as
**Zoom to fit** would. A canvas that already shows some content opens where it
is, and later edits never move the view.
| Scroll / two-finger drag | Pan |
| Double-click / double-tap in Hand mode | Zoom in on the point you pressed |

The dock carries one view control — **zoom to fit** — and it is there in
every tool. On a touch screen it is joined by **zoom in** and **zoom out**,
which take the same step as `+` and `-`, so pinching is not the only way to
get closer. There is no zoom percentage anywhere: what you can ask for is
to see everything, or to get closer to something, and the magnification
between those two is not a number you have to manage.

A corner **overview** of the whole canvas shows whenever the editor is wide
enough to hold it beside the dock. In a narrower editor, such as a phone held
upright, it sits behind a map button just above the dock, hidden until you tap
it and hidden again on a second tap; the choice lasts for the browser session.

Zooming to the selection sits in a node's right-click menu as **Zoom to
selection**; it frames every selected node, not only the one you pressed.

## History

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + Z` | Undo |
| `Cmd/Ctrl + Shift + Z` / `Cmd/Ctrl + Y` | Redo |
| `Cmd/Ctrl + S` | Save a version |

One action is one undo step: pasting twenty nodes, duplicating a
selection, or nudging several nodes each undo in a single press.

## Help

| Shortcut | Action |
|---|---|
| `?` | Open the keyboard shortcut sheet |

The sheet lists every shortcut above for your platform (`⌘` on macOS,
`Ctrl` elsewhere), grouped as Edit, Arrange, View, Text and Help. It also
opens from the **Keyboard shortcuts** button in the bottom dock, which is the
way in without a keyboard. Press `Esc` to close it; focus returns to where it
was. The dock's buttons show their shortcut in the tooltip where they have
one, as **Zoom to fit** does.

## Writing in a markdown document

These keys work in a markdown document's source and in a canvas node's text
editor. `Cmd` is the macOS modifier; use `Ctrl` everywhere else.

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + B` | Bold the selection, or the word at the caret |
| `Cmd/Ctrl + I` | Italicise the selection, or the word at the caret |
| `Cmd/Ctrl + E` | Mark the selection, or the word at the caret, as code |
| `Cmd/Ctrl + K` | Link: open the link picker over the selection or the word at the caret; where there is nothing to pick from it wraps in `[[ ]]` |
| `Cmd/Ctrl + Enter` | Cycle a task checkbox on the line (in a canvas node's editor it saves instead) |
| `Tab` / `Shift + Tab` | Indent or outdent the line, or nest a list item under the one above it; a hand-numbered list is renumbered to match |
| `Enter` on an empty list item or quote line | Remove the marker and leave the list or quote |
| `Backspace` on an empty list item or quote line | Remove the marker, leaving an empty line |

← Back to [reference](README.md)
