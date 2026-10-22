# Export and import a document

Save one document as a file, and bring a file in as a document. Works the same
whether the browser or the daemon keeps the workspace, except where noted.

## Save a document

Open the document, then **More actions → Export…**:

- **Export as PNG** or **Export as SVG** — a picture of the document.
- **Save as Markdown (.md)** — on a note: the OKF Markdown source, with the document's name
  as the frontmatter `title`.
- **Save as JSON Canvas (.canvas)** — on a canvas: the JSON Canvas source, including the
  `x-whiteboard` extension.

The browser downloads the file, and a notice confirms it ("Saved as Markdown"). An image on
a canvas is saved as an `asset:` reference to the workspace's file, not as its pixels, so
the notice says the images are referenced. Use PNG or SVG when the pixels must travel.
See the [export formats reference](../reference/export-formats.md#web-app-exports).
