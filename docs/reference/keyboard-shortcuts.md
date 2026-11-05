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
| `H` | Hand (pan) — drag anywhere to pan. A canvas opens in Select; one you come back to within the same browser session returns to whichever of Select and Hand you were last using on it |
| `V` | Select — click to select, drag to marquee |
| `C` | Connect — click one node, then another, to draw an edge |
| `D` | Draw — drag across the board to leave a freehand stroke |
| `N` | Add a note at the centre of the view, or inside the selected frame |
| `Space` + drag | Pan from any tool, without leaving it |

The four tools live in the bottom dock, and their letters show in its tooltips. The letters work from any tool and never while you are typing; with `Cmd/Ctrl` held, `C` and `D` stay copy and duplicate. On touch, two-finger drag pans and
pinch zooms in every tool.

## Selection and editing

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + A` | Select every node |
| `Shift` + click | Add or remove a node from the selection |
| `Tab` | Select the next node in reading order, visiting the connections and lines that leave a node right after it; with nothing selected, the first node |
| `Shift + Tab` | Step back through the same walk |
| `C` | With a node selected: start a connection from it (arrows choose the target, `Enter` connects, `Esc` cancels) |
| `Cmd/Ctrl + Arrows` | Select the nearest node in that direction |
| `Enter` / `F2` | Edit the selected node's text, a frame's label, or the selected connection's or line's label (a frame's, connection's or line's label is one line: `Enter` saves it) |
| `F6` / `Shift + F6` | Leave the canvas for the next control (the bottom dock) or the one before it (the header), keeping the selection. They work the same from a control in the canvas's dock, such as Undo |
| `Menu` / `Shift + F10` | Open the selection's menu — the one a right-click on it opens — at the selection; with nothing selected, the canvas menu |
| Arrow keys | Nudge the whole selection (`Shift` for a larger step) |
| `Cmd/Ctrl + Alt + M` | Comment on the selected node, nodes or connection: opens the comment composer, the same one **Comment on this** opens |
| `Delete` / `Backspace` | Delete the selected nodes, or the selected connection or line |
| Double-click | Edit a node's text or an edge's label; on empty space add a note there; on a group's name (above its top edge) edit the name; inside a group add a note in it. The same in Hand mode |
| `Cmd/Ctrl + Shift + L` | Lock or unlock the selection |
| `Cmd/Ctrl + Enter` | Save the text you are editing and close the editor |
| `Esc` | Cancel the current gesture, or clear the selection; on a connection reached with `Tab`, go back to the node it leaves; in a text edit, discard what you typed |

**Reaching a node without a pointer.** The canvas is a Tab stop, announced as
"Canvas, 5 notes. Tab selects the first note" (frames, connections, drawings and lines are counted apart, a canvas holding only a drawing says "Canvas, 1 drawing. Tab selects the first drawing", and once something is selected it says Tab selects the next node). With it focused, `Tab` walks the
nodes top to bottom, then left to right (two nodes at exactly the same spot always come in the same order),
and does not wrap: `Tab` on the last node, or `Shift + Tab` on the first, leaves
the canvas for the next control (the bottom dock, or the header before the
canvas), so the walk is never a trap. `Esc`
clears the selection and `Tab` starts the walk again; a second `Esc` with nothing
selected makes the next `Tab` the browser's, which is the way on to the bottom dock, and
the canvas then says so ("Tab leaves the canvas").
To leave without losing the selection, press `F6` (on to the dock) or
`Shift + F6` (back to the header, where the Display panel shows the selected
node) — the selection stays exactly as it was. A canvas with no nodes lets `Tab` go straight to the
dock. Locked nodes and locked connections are skipped, since they cannot be selected.

**Reaching a connection without a pointer.** The `Tab` walk visits each
connection right after the node it leaves, and each line right after the node
it starts (or ends) at; a line attached to no node comes after the last node.
A selected connection is announced with its place among the connections and
lines, as "Selected: Connection from Web App to API Gateway (2 of 5)". From
there `Enter` or `F2` edits its label, `Shift + F10` opens its menu (arrow
ends, sides, colour, comment, lock, delete), `Delete` deletes it, and `Esc`
goes back to the node you reached it from.
`Cmd/Ctrl + Arrows` jumps to the closest node in a direction, preferring the
one straight ahead over a nearer one off to the side; the plain arrow keys
still nudge.

**Connecting two nodes without a pointer.** Select a node and press `C`: the
connect starts from it and the canvas announces "Connecting from ...". The arrow
keys then choose the target in reading order (`Right`/`Down` forward,
`Left`/`Up` back), each outlined and announced as "Connect to ...", with its
text, or its kind and a short id when it has none. `Enter` makes the connection
and announces it, `Esc` cancels. `Tab` from the canvas still reaches the same
targets one by one. With nothing selected, `C` switches to the Connect tool as
before.

**The menu from the keyboard.** `Shift + F10` (or the `Menu` key) opens the menu
for what is selected, a node, a set of nodes, a connection, a line or a group, and puts focus on
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

**Tidy** (the right-click menu of a selection, or **Tidy canvas** on empty
space) lines boxes up and clears overlaps without taking anything out of its
frame: a frame's contents are tidied inside it, a frame drawn mostly inside
another, such as one made with **Frame selection**, counts as inside it, and
a frame grows down or right to make room rather than moving away from the
frames beside it. Frames are never left overlapping one another. A screen reader hears
what it did ("Tidied 6 notes in 2 frames"), or "Already tidy" when there was
nothing to move.

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

A frame carries every unlocked node that sits wholly inside it, whether you
drag it or nudge it with the arrow keys, and the move is one undo step.
With a frame selected, or a node that sits inside one, `N` puts the new note
in that frame's next free spot (the innermost frame, when frames nest), 32px
clear of what it already holds, and grows the frame if it is full. So typing
a note, pressing `Escape` and pressing `N` again keeps filling the same frame. A new
note or frame never lands over a frame's name. A frame is carried by its border band and its name strip. A drag that starts on
the frame's empty interior sweeps a selection band instead, so you can pick up
the notes inside without moving the frame; a tap there still selects the frame.
A press that moves less than a few pixels is a tap: the node stays exactly where
it was.

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

A cut does not remove anything until you paste: the cut nodes stay in place
under a veil, a chip says how many are held, and a screen reader hears it ("1
node held — paste to place, Escape to cancel"). `Esc` lifts the hold.

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
| Scroll / two-finger drag | Pan |
| Double-tap in Hand mode (touch) | Zoom in on the point you pressed; with a mouse or pen a double-click edits or adds a note instead, and never moves the view |

Each canvas remembers where you were looking, for the rest of the browser
session: leave it or reload the page and it reopens at the same pan and zoom,
separately for each document. A new session, or a canvas that has no memory
yet, opens at the origin, and when none of its content is in view there (or
in the remembered position) it opens framed on the content, as **Zoom to fit**
would. Later edits never move the view.

When a panel covers part of the canvas, as the inspector does in a narrow
window, **Zoom to fit**, **Zoom to the selection** and the jump to a comment
frame their target in the part you can still see, and opening a panel over the
selected node moves it clear. **Zoom to fit** and **Zoom to the selection**
also keep what they frame clear of the dock along the bottom and of the
overview map in the corner, and leave room along the top for the action
buttons a selected node shows above itself.


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
While you type into a note, label or comment the overview steps aside, so it
never sits under the formatting bar or the on-screen keyboard.

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
Redo under Edit and a closing line that Align, Distribute, Tidy and Frame selection
have no key and live in the Select tool's right-click menus (`Shift + F10` opens the same menus from the keyboard) — Align and Distribute on
a selection of two or more nodes — since the Hand tool's right-click offers
comments only. It also
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
| `Enter` on an empty list item or quote line | Remove the marker and leave the list or quote. A blank line is left after the list, so the next line you type is a paragraph of its own rather than part of the last item |
| `Backspace` on an empty list item or quote line | Remove the marker, leaving an empty line |
| `Esc`, then `Tab` or `Shift + Tab` | Leave the editor forwards or backwards; `Tab` alone indents |

The formatting bar above a markdown document is one `Tab` stop. `Left` and `Right` move between its buttons, `Home` and `End` jump to the first and last, and `Tab` leaves it; coming back with `Shift + Tab` lands on the button you were last on.

## On the canvas with a screen reader

The text fields that open over a canvas say what they edit: "Text of Review"
for a note, "Name of frame cluster" for a frame's name, "Label of edge from A
to B" for a relation's label. A note's text is described as "Escape discards,
Ctrl+Enter keeps" (`Command` on a Mac); a frame's name and a connection's or
line's label, being one line, as "Escape discards, Enter keeps". Pressing
`Esc` announces "Discarded" so a thrown-away draft is not silent. The one exception is a note you have just
added: `Esc` on it keeps what you typed and says so ("Note kept: Review"),
because a typed note lost to the key that closes the editor would have no
undo. Press `Esc` on a new note before typing and it is removed; leaving the canvas
while a new note is still empty removes it too.

On an empty canvas the cue to add a note is part of the canvas's description, so
it is read with the canvas. Choosing a tool, by key or from the dock, announces
it ("Hand tool", "Select tool", "Connect tool", "Draw tool"). On a canvas with
notes, the Connect tool also shows what to press at the top of the canvas —
"Click the first note, then the second" ("Tap…" on a touch screen), then "Now
click the note to connect to" once the first is chosen — and the first line is
announced with the tool's name.

Every node, connection and line is listed by name for a screen reader, in the
order `Tab` walks them: nodes by where they sit, top to bottom and then left to
right, not by the order they were added, so a note placed above another is read
first, each followed by the connections and lines that leave it. The
canvas points at the selected one: a note by its first
line, a frame as "Frame cluster", a connection as "Connection from Review to
Ship: then". A stroke made with Draw is listed as "Drawing", and a line dragged
out to empty space as "Line from Review to empty space"; neither is called a
connection, because a line asserts no relation.
Selecting says where you are ("Selected: Review (2 of 5)", "Selected 3 nodes"),
including the frame a node sits in ("Selected: Web App, in Frontend (3 of 8)"),
and what you do is said back: "Note added", "Connected Review to Ship",
"Framed 3 nodes", "Deleted 2 nodes". Moving a node across a frame's edge, by
nudging or dragging, is said too ("Web App moved into Backend", "Web App left
Frontend", "Web App moved from Frontend into Backend"); a move that stays inside
its frame says nothing, so a run of nudges is quiet until one crosses an edge. Choosing how edges are drawn in the
Display panel is said back the same way ("Edge routing: Orthogonal", "Line
jumps: On").

The controls around a selected node name it ("Resize Review, south-east",
"More actions for Review") and add three `Tab` stops, not thirteen: the
south-east resize handle (the arrow keys resize from it), the right-hand
connect handle and the actions button.

Whatever you finish on the canvas leaves the keyboard on it: keeping a label
with `Enter` (or `Ctrl + Enter`) or discarding it with `Esc`, completing a connection, choosing
Group from the dock, and closing a dialog or the context menu with `Esc`.
`Delete`, the arrow keys and undo work straight away, with no click first.

## Moving between pages

Opening a document, returning to the list or opening Settings has a screen
reader say where you are ("Roadmap, markdown note", "Plan, canvas",
"Documents"), and the browser tab is titled the same way ("Roadmap ·
Whiteboard"). Where keyboard focus lands depends on the page:

- **A note** puts it on the note's heading, directly above its text. A new,
  empty note is the exception: its editor takes focus, so you can type at once.
- **A canvas** puts it on the canvas itself, empty or not, so a shortcut such
  as `N` or an arrow key works the moment the canvas appears — straight after
  **Create a canvas**, with no click first.
- **The document list** puts it on its heading, and coming back from a
  document you opened from the list (**Back**, or the browser's back) puts it
  on that document's card instead, so you carry on where you were.
- **Settings** does not move focus, so the next Tab starts from the top of the page.

The first Tab stop on every page is **Skip to content**, hidden until it is
focused: it moves focus past the app's header and the page's own header to
the canvas, the note's editor, or the start of the page's content. When the
app first opens on a page that puts focus on its heading, the first `Tab`
still goes to **Skip to content**; after that, `Tab` from a page's heading
goes on into the page.

## Searching the document list

In the document list's search box, the results are one key away, and a screen
reader hears how many there are once the search settles ("3 results for
“map”", or "No results for “map”"). A search that takes longer than a moment
shows "Searching…". The box is a combobox over its results: focus stays in it
while the arrow keys highlight a result, so you can keep typing, and a screen
reader names the highlighted one.

| Shortcut | Action |
|---|---|
| `ArrowDown` / `ArrowUp` in the search box | Highlight the next or previous result; `ArrowUp` on the first highlights none |
| `Enter` in the search box | Open the highlighted result, or the first when none is highlighted |
| `Escape` in the search box | Drop the highlight; with none, clear the search |
| `ArrowDown` / `ArrowUp` on a result reached with `Tab` | Move to the next or previous result; `ArrowUp` on the first returns to the box |
| `Enter` on a result | Open the document |

← Back to [reference](README.md)
