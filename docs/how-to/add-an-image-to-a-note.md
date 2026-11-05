# Add an image to a note

Put a photo or screenshot inside a markdown note, where you are writing.

## Add one

With the caret where the picture should go, do any of these:

- Press **Image…** in the formatting bar, or in **Editing actions** (⋯). On a phone it is
  under **More formatting** in the bar above the keyboard. Pick a file; on a phone the
  chooser offers the photo library and the camera.
- Paste an image you copied.
- Drop an image file onto the text.

While the file uploads the editor says "Uploading *name*…". It is stored in the same place a
canvas's **Add > Image** stores pictures — this browser, or the daemon that keeps the
workspace — and the note gets one line of Markdown where the caret was:

```markdown
![meter reading](asset:…)
```

The text in the brackets is the picture's alt text, taken from the file name. Edit it in the
source to describe the picture. **Split** and **Read** show the picture itself.

The accepted types and the size limit are the canvas's: PNG, JPEG, GIF, WebP and SVG, up to
the upload limit. Anything else is refused before it uploads, and the editor says why; so is
an upload the keeper turns away.

## What else to know

- An image a note names is never removed by the workspace's file clean-up, also while the
  note is in the trash or in a saved version.
- **Save as Markdown (.md)** saves the line above as text and no pixels: the file names the
  picture by its `asset:` reference, which only this workspace can resolve. See
  [export and import a document](export-and-import-a-document.md).
- Deleting the line removes the picture from the note; the file goes in a later clean-up once
  nothing names it.

← Back to [How-to guides](README.md)
