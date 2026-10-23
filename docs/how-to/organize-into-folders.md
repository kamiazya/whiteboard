# Organize documents into folders

A folder is the front of a document's path: `design/login` lives in `design`.
There is no separate folder object, so a folder exists while a document is in
it, and moving a document or renaming a folder is a change of path. The
document keeps its id, its links and its history through either.

## Move a document to a folder

Open the document's menu — right-click its card or row, or long-press it on a
touch screen, or press Shift+F10 on a focused card — and choose **Move to
folder…**. The picker lists the workspace root and every folder, plus **New
folder…**:

- Arrow keys walk the list, **Enter** picks, **Escape** cancels.
- **New folder…** asks for a name and moves the document into it; type
  `plans/q4` to make a folder inside a folder.
- If the destination already has a document with the same last segment, the
  move is refused with the path that collided and nothing moves.

With a mouse or a pen you can also drag a card or row onto a folder — a folder
card, a folder in the tree beside the list, or **Workspace** for the root. The
folder highlights while the document is over it. On a touch screen the menu is
the way; dragging is not offered, so a long press cannot be mistaken for the
start of a drag.

A move is announced to screen readers as "Moved *name* to *folder*".

## Rename a folder

Right-click a folder (a card in the list or an entry in the tree) and choose
**Rename…**. Type the new name — a single segment, no `/` — and press **Enter**;
**Escape** cancels. Every document under the folder moves with it, and links
that named the old paths are repointed the same way a document's own rename
repoints them.

## Start a new subfolder

**New subfolder…** in the same menu asks for a name and opens that folder.
Because a folder exists only while a document is in it, the new folder is empty
until you create a document there or move one in; leaving it without doing
either lets it go.
