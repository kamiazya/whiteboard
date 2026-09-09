# Choose a theme for a canvas

A theme decides HOW a canvas is drawn — hand-drawn strokes, a neon glow — without touching
what it says. It is stored on the document, so every collaborator, every thumbnail and every
export that asks for it see the same look. Two themes ship with the bundled `visual` plugin:

| id | look |
|---|---|
| `visual.sketch` | hand-drawn: jittered strokes, hatched fills, dashed group frames; edges stay straight |
| `visual.neon` | glowing strokes on a deep-navy night (light mode gets a pale paper and darker strokes) |

The paper follows your UI mode: every theme carries a light and a dark palette, and the editor
picks the one matching your settings.

## From the editor

1. Open the document's **⋯** menu and choose **Display…**.
2. Under **Theme**, pick **Sketch** or **Neon**. The canvas redraws at once; the popover stays
   open so you can compare.
3. **Default** removes the theme again.

The same panel has a **Draw as** row for this tab only: **As saved** draws what the document
says, **Clean** draws the bundled look, and **Preview sketch** / **Preview neon** try a theme
without storing it. Nothing here is written to the document or seen by anyone else, and the
row thumbnails in the document list keep drawing the saved look.

The colour swatches in a node's or edge's menu preview the theme's own palette, so the chip you
pick is the stroke you get.

A theme can carry its own **Edge routing** default (neon routes orthogonally; sketch keeps
straight lines). The routing row shows whichever is in force, and a routing you choose there
beats the theme's — including choosing **Straight** on a board whose theme routes otherwise.
Picking the theme's own default leaves nothing stored, so the row follows the theme again.

## From an agent

The theme is the `visual.theme/v0` facet on the canvas. Set it with `wb_facet_set`'s canvas
target (a spatial document has no frontmatter to hold facets, so `target: 'canvas'` says where
the write lands):

```json
{ "workspaceId": "default", "documentIds": ["<id>"], "target": "canvas",
  "facets": { "visual.theme/v0": { "theme": "visual.neon" } } }
```

A theme id nothing registered is refused with the list of registered ids; `null` clears it.

## Rendering with a theme

`wb_scene_render` draws the bundled look by default — an agent reading SVG never pays for a
theme's jittered geometry or glow unless it asks. Pass `style`:

- `"document"` draws the theme the canvas names.
- a theme id such as `"visual.sketch"` previews that theme without storing it.
- `"clean"` (the default) ignores the document's theme.

The daemon's PNG and SVG export routes take the same `style`, optional, with the same default.
The web editor's own export draws what you see, theme included.

## Fonts

The sketch theme names the **Yomogi** handwriting family (Japanese and Latin in one hand, OFL).
It is not bundled — it is 4 MB — so the web app fetches it the first time a board you open draws
in that theme, from the Google Fonts catalogue's own repository (the same file the daemon
installs), and registers the face on the page and in its layout workers. The editor, the row
thumbnails and the browser's own PNG export then draw the same glyphs; a board already open
redraws when the face lands. Nothing is fetched for a board that names no theme, and the face is
held for the tab.

For the daemon's own rendering — `wb_scene_render` and the export routes — open **Settings →
Fonts** while connected and install **Yomogi**. The daemon keeps the file and measures and
declares it from then on; the web app takes the daemon's copy when it has one, and the catalogue
source otherwise.

Offline, or where the source cannot be reached, the theme still draws its hand-drawn strokes and
the lettering uses the bundled family. The SVG names the family that was actually measured,
never one that was not, so the coordinates and the face always agree.

← Back to [how-to guides](README.md)
