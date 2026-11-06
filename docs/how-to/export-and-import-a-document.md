# Export and import a document

Save one document as a file, and bring a file in as a document. Works the same
whether the browser or the daemon keeps the workspace, except where noted.

## Save a document

Open the document, then **More actions → Export…**:

- **Export as PNG** or **Export as SVG** — on a canvas: a picture of it. The picture leaves
  out the comments: no pins, cards, region outlines or highlighted passages.
- **Export as PNG (with comments)** or **Export as SVG (with comments)** — on a canvas: the
  same picture with the comments drawn in, as the editor shows them.
- **2× resolution (PNG)** and **With background** — on a canvas, two checkboxes at the
  bottom of the submenu, remembered in this browser, that apply to all four picture entries. By default
  a picture is 1×, filled with the white paper of the light theme the export is drawn in.
  Tick **2× resolution** for a PNG twice as many pixels wide and tall (an SVG has no pixels
  and is unaffected); untick **With background** for a transparent picture. The menu stays
  open when you tick one, so you can set both before choosing a format.
- **Selection only (N items, PNG/SVG)** — on a canvas with nodes selected, a third checkbox
  above those two. Ticked, the four picture entries draw just the selection: a selected
  group brings the nodes inside it, and an edge, a line or a comment comes along only when
  what it is attached to does. It is not remembered — it applies to this open of the menu —
  and **Save as JSON Canvas** always saves the whole document.
- **Save as Markdown (.md)** — on a note, the only entry its Export… submenu offers: the
  OKF Markdown source, with the document's name as the frontmatter `title`. A note has no
  picture export. The file is text only: an image in the note is saved as its
  `![alt](asset:…)` line, not as pixels ([add an image to a note](add-an-image-to-a-note.md)),
  and an embedded document as its `![[…]]` line. The entry says so under its name, and when
  the note has either, the confirmation says the pictures and embedded diagrams are not
  included. For a handout with them, print the note instead (below).
- **Save as JSON Canvas (.canvas)** — on a canvas: the JSON Canvas source, including the
  `x-whiteboard` extension.

The browser downloads the file, and a notice confirms it ("Saved as Markdown"). An image on
a canvas is saved as an `asset:` reference to the workspace's file, not as its pixels, so
the notice says the images are referenced. Use PNG or SVG when the pixels must travel.
See the [export formats reference](../reference/export-formats.md#web-app-exports).

## Print a note, or save it as a PDF

Open the note, then **More actions → Print / Save as PDF…**. The note switches to **Read**
for the print, and the browser's print dialog opens; choose a printer, or **Save as PDF** as
the destination for a file. When the dialog closes the note goes back to the view you had.

What prints is the read view and nothing else: the title, then the body with its pictures
and embedded canvases, over as many pages as it takes. It prints in the light theme, dark
ink on white paper, whatever theme the app is showing; the screen keeps its own. A body that
already opens with the title as its heading prints it once. A page breaks between paragraphs,
pictures and embeds, never through one, and never right after a heading: a heading prints
on the same page as the block it introduces, a picture or an embed included. A single
block taller than a page, such as a long code block, is the exception: it starts on a new
page and runs on over the pages it needs, with nothing cut off. The app around the note — the top bar, the toolbars, the scroll overview — does
not print. Comments on an embedded canvas are left out, as they are wherever a canvas is
shown inside something else. The browser's own **Print** (`Ctrl+P` / `Cmd+P`) prints the
same thing in **Read** and **Split**; from **Write**, use the menu entry.

## Bring a file in

On the document list, choose **New → Import file…** and pick a file, or drop files onto the
list. Accepted: `.md`, `.markdown` (a note), `.canvas`, `.json` (a canvas, JSON Canvas 1.0).

- The document is created in the folder you are viewing. Its file name becomes the path;
  when that path is taken, a number is added (`-2`, `-3`).
- A note's name is its frontmatter `title`, or the file name when there is none. A canvas is
  named after the file. Markdown with no frontmatter becomes a plain note.
- One imported file opens; several leave the last one selected, and any that failed are
  listed by name with the reason.
- A file that is not one of the accepted kinds, or that does not parse, is refused with a
  notice saying so; nothing is created and the page stays where it is.
- Images a canvas references by `asset:` are not carried by the file, so they appear only
  when the workspace already holds them.
