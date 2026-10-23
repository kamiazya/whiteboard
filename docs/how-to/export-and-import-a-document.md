# Export and import a document

Save one document as a file, and bring a file in as a document. Works the same
whether the browser or the daemon keeps the workspace, except where noted.

## Save a document

Open the document, then **More actions → Export…**:

- **Export as PNG** or **Export as SVG** — a picture of the document. On a canvas the
  picture leaves out the comments: no pins, cards, region outlines or highlighted passages.
- **Export as PNG (with comments)** or **Export as SVG (with comments)** — on a canvas: the
  same picture with the comments drawn in, as the editor shows them.
- **Save as Markdown (.md)** — on a note: the OKF Markdown source, with the document's name
  as the frontmatter `title`.
- **Save as JSON Canvas (.canvas)** — on a canvas: the JSON Canvas source, including the
  `x-whiteboard` extension.

The browser downloads the file, and a notice confirms it ("Saved as Markdown"). An image on
a canvas is saved as an `asset:` reference to the workspace's file, not as its pixels, so
the notice says the images are referenced. Use PNG or SVG when the pixels must travel.
See the [export formats reference](../reference/export-formats.md#web-app-exports).

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
