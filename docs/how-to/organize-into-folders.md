# Organize documents into folders

A folder is the front of a document's path: `design/login` lives in `design`.
A folder exists while a document is in it, and moving a document is a change
of path; the document keeps its id, its links and its history through it.

A folder has two things a document has too: an **address** — its part of the
path, which is what links and the URL carry — and a **name**, which is what the
list, the tree, the folder path above the list and the move picker show. A
folder you make here gets its address from its name once, when it is made,
and from then on the two are separate: renaming the folder changes only its
name. A folder nobody has named shows its address.

An address is ASCII — letters `a`–`z`, digits and hyphens — so it reads the same
in every URL and `[[link]]`. It is made from the name: lower-cased, accents
taken off their letters (`Équipe Ops` becomes `equipe-ops`, `Straße` becomes
`strasse`, `Æsir` becomes `aesir`), and every run of spaces or punctuation
turned into one hyphen. A name with nothing the address can spell — `第六週`,
or only emoji — becomes `folder`, or `folder-2`, `folder-3` … when that is
taken; a new document named that way becomes `note` or `canvas` the same way.
An address another folder or document beside it already holds is numbered past
it in the same way.

## Move a document to a folder

Open the document's menu — right-click its card or row, tap the **…** button
on it (shown on a touch screen), long-press it, or press Shift+F10 on a focused
card — and choose **Move to folder…**. With the document open, the same entry is in its
**More actions** menu at the top right, and the page follows the document to its new address.
The picker lists the workspace root and every folder, plus **New folder…**:

- Arrow keys walk the list, **Enter** picks, **Escape** cancels.
- Each folder is listed by its names from the top down — `Class / Week 6` —
  so two folders called the same in different places can be told apart.
- **New folder…** asks for a name and moves the document into it. A `/`
  nests: `Class/Week 6` makes a folder called **Class** with a folder called
  **Week 6** inside it — or, when the top level already has a folder called
  Class, makes only **Week 6** inside that one. Each part that matches a folder
  already there — by its name or by its address, ignoring case — is that
  folder, the last part included: typing `Q3 Planning/Hiring` when that folder
  exists moves the document into it and makes nothing.
- If the destination already has a document with the same last segment, the
  move is refused with the path that collided and nothing moves.
- If a document already in the folder shows the same name — its name, or its
  last path segment when it has none, compared ignoring case and surrounding
  spaces — the move is refused with that name and nothing moves. Rename one of
  the two first. This holds for dragging, for a rename that changes the path,
  and for a folder moved under a folder with a same-named folder.

With a mouse or a pen you can also drag a card or row onto a folder (the
picker says so once, under its list, beside the keyboard way back to it:
`Shift + F10` on a card, then **Move to folder…**) — a folder
card, a folder in the tree beside the list, or **Workspace** for the root. The
folder highlights while the document is over it. On a touch screen the menu is
the way; dragging is not offered, so a long press cannot be mistaken for the
start of a drag.

A drop that cannot be made — the folder already holds a document showing the
same name, say — moves nothing, and the reason appears at the bottom of the
screen until you dismiss it.

A move is announced as "Moved _name_ to _folder_", with the folder's name —
including the name you just gave a folder the move made.

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
name. A refused name is said beside the field before anything is saved, quoting
the other folder's name as it is written and, for a folder inside another, the
folder it is in: 'Another folder in "Q3 Planning" is already called "Hiring"'. Two
folders that came to share a name by syncing two copies of the workspace keep
both names; nothing is renamed for you.

Names nobody typed follow the same rule without asking you. A note that is
still unnamed takes its name from its first heading only when no other
document in its folder already shows that name; otherwise it stays
**Untitled** until you name it. **Duplicate** names the copy
"Name (copy)", or the first "Name (copy 2)", "Name (copy 3)" … that nothing
beside it shows; a copy of an unnamed document starts from what its row shows,
so a copy of a document listed as "Untitled 3" is "Untitled 3 (copy)". The copy is selected in the list, and a
"Duplicated _name_" notice offers **Open** for it.

**Duplicate** copies the whole document, its comments and open proposals
included. **Duplicate without comments**, next to it in a document's menu, in the
preview beside the list, and in an open document's **More actions**, copies only what the document says:
the copy starts with no comment threads and no proposals, and the original
keeps every one of its own. The copy is named and placed the same way, and
the notice reads "Duplicated _name_ without comments". Both
are offered on every document; on one that has no comments they make the
same copy.

A daemon from before **Duplicate without comments** existed copies the
comments anyway. The app notices and says so — "This daemon is too old to
duplicate without comments — update it" — rather than reporting a clean
copy; the copy that daemon made is left for you to keep or delete.

When a duplicate fails, the page says so above the list and reads the list
again, in the browser and on a daemon alike. A failure can come after the copy
was already made — the answer lost on its way back — so check the list for a
copy before trying again.

A document that has documents under it (`plan` beside `plan/outline`) is
listed as a folder too, but there is no folder of its own to name there, so
its menu has no **Rename…**; rename the document instead.

## Make a new folder

**New folder** above the list (in the two-column view) makes a folder inside
the folder you are in — at the workspace root, a top-level folder. The same entry is in a folder's own
menu, as **New subfolder…** (or **New folder…** on **Workspace** in the folder
path). It asks for a name; **Create folder** opens the new folder, showing the
name you gave it, with keyboard focus on its name in the folder path and a
screen reader told "In _name_, empty". After a move, focus goes to the folder
the document went to (or the document itself, after **Move documents here…**).

A folder exists only while a document is in it, and the dialog says so before
you create it: the new folder is empty until you put a document there, and its
name is kept by the page until then and saved with the folder once a document
lands in it. The empty folder offers **New note here** and **New canvas here**,
which create the document inside it, and **Move documents here…**, which lists
every other document in the workspace with a checkbox and where it is now: tick
the ones to file there and choose **Move here**. Leaving it empty lets it go,
name and all. The same duplicate rule as a rename applies.

The page keeps a folder's name the same way when a move takes the last document
out of it: move a document back in during the same visit and the folder comes
back under its name rather than its address.
