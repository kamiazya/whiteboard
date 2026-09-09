# Choose a theme for a canvas

A theme decides HOW a canvas is drawn — hand-drawn strokes, a neon glow — without touching
what it says. It is stored on the document, so every collaborator, every thumbnail and every
export that asks for it see the same look. Two themes ship with the bundled `visual` plugin:

| id | look |
|---|---|
| `visual.sketch` | hand-drawn: jittered strokes, hatched fills, curved edges, dashed group frames |
| `visual.neon` | glowing strokes on a deep-navy night (light mode gets a pale paper and darker strokes) |

The paper follows your UI mode: every theme carries a light and a dark palette, and the editor
picks the one matching your settings.

## From the editor

1. Open the document's **⋯** menu and choose **Display…**.
2. Under **Theme**, pick **Sketch** or **Neon**. The canvas redraws at once; the popover stays
   open so you can compare.
3. **Default** removes the theme again.

The colour swatches in a node's or edge's menu preview the theme's own palette, so the chip you
pick is the stroke you get.

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

The sketch theme names a handwriting family. It is declared in the SVG only where the renderer
can measure it — the vendored face, or one installed through the daemon (see
[install-fonts-for-export](install-fonts-for-export.md)) — and otherwise the bundled family
is used, so the coordinates and the face always agree.

← Back to [how-to guides](README.md)
