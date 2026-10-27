# Organize documents into folders

A folder is the front of a document's path: `design/login` lives in `design`.
A folder exists while a document is in it, and moving a document is a change
of path; the document keeps its id, its links and its history through it.

A folder has two things a document has too: an **address** — its part of the
path, which is what links and the URL carry — and a **name**, which is what the
list, the tree, the folder path above the list and the move picker show. A
folder you make here gets its address from its name once, when it is made
("Week 6" becomes `week-6`; a name with no letters the address can spell, such
as `第六週`, becomes `folder`), and from then on the two are separate: renaming
the folder changes only its name. A folder nobody has named shows its
address.

## Move a document to a folder

Open the document's menu — right-click its card or row, tap the **…** button
on it (shown on a touch screen), long-press it, or press Shift+F10 on a focused
card — and choose **Move to folder…**. The picker lists the workspace root and every folder, plus **New
folder…**:

- Arrow keys walk the list, **Enter** picks, **Escape** cancels.
- Each folder is listed by its names from the top down — `Class / Week 6` —
  so two folders called the same in different places can be told apart.
- **New folder…** asks for a name and moves the document into it. A `/`
  nests: `Class/Week 6` makes a folder called **Class** with a folder called
  **Week 6** inside it — or, when the top level already has a folder called
  Class, makes only **Week 6** inside that one. A name another folder in the
  same place already has is refused, with the name; pick that folder from the
  list instead.
- If the destination already has a document with the same last segment, the
  move is refused with the path that collided and nothing moves.

With a mouse or a pen you can also drag a card or row onto a folder — a folder
card, a folder in the tree beside the list, or **Workspace** for the root. The
folder highlights while the document is over it. On a touch screen the menu is
the way; dragging is not offered, so a long press cannot be mistaken for the
start of a drag.

A move is announced to screen readers as "Moved _name_ to _folder_".

## Rename a folder

Right-click a folder (a card in the list or an entry in the tree) and choose
**Rename…**. On a touch screen use the **…** button beside the folder —
the segments of the folder path above the list carry one too — or long-press
it. Type the new name and press **Enter**; **Escape** cancels. Only the name
changes: the folder's address, every document's path under it and every link
into it stay as they are.

The name cannot be blank, cannot contain `/` (which separates folders), and
cannot be the name another folder directly beside it already shows — compared
ignoring case and surrounding spaces, so `week 6` and `Week 6` are the same
name. A refused name is said beside the field before anything is saved. Two
folders that came to share a name by syncing two copies of the workspace keep
both names; nothing is renamed for you.

Names nobody typed follow the same rule without asking you. A note that is
still unnamed takes its name from its first heading only when no other
document in its folder already shows that name; otherwise it stays
**Untitled** until you name it. **Duplicate** names the copy
"Name (copy)", or the first "Name (copy 2)", "Name (copy 3)" … that nothing
beside it shows.

A document that has documents under it (`plan` beside `plan/outline`) is
listed as a folder too, but there is no folder of its own to name there, so
its menu has no **Rename…**; rename the document instead.

## Start a new subfolder

**New subfolder…** in the same menu asks for a name and opens that folder,
showing the name you gave it. Because a folder exists only while a document is
in it, the new folder is empty until you create a document there or move one
in — its name is kept by the page until then and saved with the folder once a
document lands in it. Leaving it without doing either lets it go, name and all.
The same duplicate rule as a rename applies.
