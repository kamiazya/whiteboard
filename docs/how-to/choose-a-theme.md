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

1. Press **Display** in the document's toolbar — the sliders icon, beside the comments and
   history buttons. The settings open next to the canvas, or as a sheet over it on a phone.
2. Under **Theme**, pick **Sketch** or **Neon**. Each option draws the whiteboard's own
   signature mark the way that theme draws it — plain, hand-drawn, or lit — so you can see
   the look before you take it. The canvas redraws at once; the panel stays open so you can
   compare.
3. **Default** removes the theme again.
4. Press **Display** again, or the **×** on the sheet, to close it.

Every option in this panel is a small picture rather than a word. Hover one, or read it with
a screen reader, to hear its name.

The colour swatches in a node's or edge's menu preview the theme's own palette, so the chip you
pick is the stroke you get.

A theme can carry its own **Edge routing** default (neon routes orthogonally; sketch keeps
straight lines). The routing row draws each option as the line it makes — a diagonal, a
right-angle step, a curve — and shows whichever is in force. A routing you choose there beats
the theme's, including choosing the straight line on a board whose theme routes otherwise.
Picking the theme's own default leaves nothing stored, so the row follows the theme again.

**Line jumps** is the row below it, drawn as two crossing lines with and without a hop over
the crossing.

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
thumbnails and the browser's own PNG export then draw the same glyphs, and so does the in-place
editor when you double-click a node or a label; a board already open redraws when the face lands.
Nothing is fetched for a board that names no theme, and the face is held for the tab.

For the daemon's own rendering — `wb_scene_render` and the export routes — open **Settings →
Fonts** while connected and install **Yomogi**. The daemon keeps the file and measures and
declares it from then on; the web app takes the daemon's copy when it has one, and the catalogue
source otherwise.

Offline, or where the source cannot be reached, the theme still draws its hand-drawn strokes and
the lettering uses the bundled family. The SVG names the family that was actually measured,
never one that was not, so the coordinates and the face always agree.

← Back to [how-to guides](README.md)
