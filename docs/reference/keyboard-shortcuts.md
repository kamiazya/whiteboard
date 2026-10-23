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
| `H` | Hand (pan) — drag anywhere to pan. A canvas with content opens in Hand, an empty one in Select, and a canvas you have used before in this browser session reopens in whichever of the two you were last using on it, chosen or not |
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
| `Tab` | Select the next node in reading order; with nothing selected, the first |
| `Shift + Tab` | Select the previous node in reading order |
| `Cmd/Ctrl + Arrows` | Select the nearest node in that direction |
| `Enter` / `F2` | Edit the selected node's text, or a group's label |
| `Menu` / `Shift + F10` | Open the selection's menu — the one a right-click on it opens — at the selection; with nothing selected, the canvas menu |
| Arrow keys | Nudge the whole selection (`Shift` for a larger step) |
| `Cmd/Ctrl + Alt + M` | Comment on the selected node, nodes or edge: opens the comment composer, the same one **Comment on this** opens |
| `Delete` / `Backspace` | Delete the selected nodes, or the selected edge |
| Double-click | Edit a node's text or an edge's label; on empty space add a note there; on a group's name (above its top edge) edit the name; inside a group add a note in it. The same in Hand mode |
| `Cmd/Ctrl + Shift + L` | Lock or unlock the selection |
| `Cmd/Ctrl + Enter` | Save the text you are editing and close the editor |
| `Esc` | Cancel the current gesture, or clear the selection; in a text edit, discard what you typed |

**Reaching a node without a pointer.** The canvas is a Tab stop, announced as
"Canvas, 5 notes. Tab selects the first note". With it focused, `Tab` walks the
nodes top to bottom, then left to right (ties by position in the document),
and wraps at the end, so focus stays on the canvas while you cycle. `Esc`
clears the selection and `Tab` starts the walk again; a second `Esc` with nothing
selected makes the next `Tab` the browser's, which is the way on to the bottom dock. A canvas with no nodes lets `Tab` go straight to the
dock. Locked nodes are skipped, since they cannot be selected.
`Cmd/Ctrl + Arrows` jumps to the closest node in a direction, preferring the
one straight ahead over a nearer one off to the side; the plain arrow keys
still nudge. Together with `Enter` and the connect handle this is enough to
connect two existing nodes using only the keyboard: while a connect is armed,
`Tab` from the canvas moves to the first box it could attach to and on between them, `Esc` cancels, each announced by its text
(or its kind and a short id when it has none) and outlined while focused, and
`Enter` attaches.

**The menu from the keyboard.** `Shift + F10` (or the `Menu` key) opens the menu
for what is selected, a node, a set of nodes, an edge or a group, and puts focus on
its first row. `Arrow Up` / `Arrow Down` step through the rows, `Home` and
`End` jump to the first and last, `Enter` runs the one under focus, and `Esc`
closes the menu and returns focus to the canvas. While a menu is open no other
canvas key acts: the arrows do not nudge the node behind it, and the tool and
note letters stay silent.

**Align and distribute** have no shortcut — they live in the right-click
menu of a multi-node selection, as **Align** (six edges and centre lines)
and **Distribute** (horizontal, vertical). Align appears once two nodes are
selected; distribute once there are three, because it repositions the
middle ones and leaves the outermost two anchoring the span. Both align to
the selection's own bounding box, so the result does not depend on which
node you clicked first, and each is a single undo step. Choosing one closes the
menu so the result is in view, and a screen reader hears what was done (for
example "Aligned 3 nodes left").

A locked node shows a small padlock in its top-right corner so you can tell it
from one that is simply unresponsive; the padlock appears in the editor only
and never in an export. A locked node or edge cannot be selected, moved, restyled, or deleted, and
MCP tools refuse to patch, tag, or set facets on it too. Right-click it and choose **Unlock** to
release it. Nodes and edges lock independently: locking a node does not
lock the edges attached to it, and an edge between two locked nodes stays
editable until you lock the edge itself. The lock is editor state — it is
stored alongside the canvas but never appears in an export.

A locked node takes the press: dragging it moves nothing, not even the frame
around it, and a brief "Locked — unlock from the menu" notice says why. A
frame holding an edge gives way to the edge, so you can select, label or
restyle that edge by pressing it; the frame is selected from its border.

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
| Double-tap in Hand mode (touch) | Zoom in on the point you pressed; with a mouse or pen a double-click edits or adds a note instead, and never moves the view |

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
`Ctrl` elsewhere), grouped as Tools, Navigate, Edit, Arrange, View, Text and Help, with Undo and
Redo under Edit and a closing line that Align, Distribute, Tidy and Group have
no key and live in the right-click menus. It also
opens from the **Keyboard shortcuts** button in the bottom dock, which is the
way in without a keyboard. Press `Esc` to close it; focus returns to where it
was. The dock's buttons show their shortcut in the tooltip where they have
one, as **Zoom to fit** does.

## Inside a menu

The right-click and **More actions** menus take focus on their first labelled
action (not a colour swatch; reach the swatches with `Up` or `Left`) and are one
Tab stop. `Up` and `Down` move between items and wrap; `Home` and
`End` jump to the first and last; typing a letter jumps to the next item that
starts with it. In a row of choices such as the colour swatches, `Left` and
`Right` move within the row. `Enter` or `Space` activates the item, and
`Esc` closes the menu and returns focus to the control that opened it.

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
| `Esc`, then `Tab` or `Shift + Tab` | Leave the editor forwards or backwards; `Tab` alone indents |

The formatting bar above a markdown document is one `Tab` stop. `Left` and `Right` move between its buttons, `Home` and `End` jump to the first and last, and `Tab` leaves it; coming back with `Shift + Tab` lands on the button you were last on.

## Searching the document list

In the document list's search box, the results are one key away, and a screen
reader hears how many there are once the search settles ("3 results for
“map”", or "No results for “map”"). A search that takes longer than a moment
shows "Searching…".

| Shortcut | Action |
|---|---|
| `ArrowDown` in the search box | Move to the first result |
| `ArrowDown` / `ArrowUp` on a result | Move to the next or previous result; `ArrowUp` on the first returns to the box |
| `Enter` on a result | Open the document |

← Back to [reference](README.md)
