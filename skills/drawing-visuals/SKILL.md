---
name: drawing-visuals
description: Draw and annotate visuals with your AI agent on a shared Excalidraw canvas. Use it when screen layout, structure, flow, or comparison still feels too ambiguous in text alone.
---

# drawing-visuals

Like a whiteboard on the wall of a meeting room, this is a tool for AI and humans to **align by drawing on the same Excalidraw workspace**.
Use it when drawing and pointing is faster than iterating in prose.
What you draw stays on the canvas and can be revisited and refined later.

Use the whiteboard MCP tools (`canvas_create` / `canvas_list` / `canvas_open` / `template_list` / `template_insert` / `library_catalog_list` / `library_list_items` / `library_insert_item` / `library_insert_batch` / `user_library_save` / `user_library_list` / `user_library_remove` / `user_library_metadata_get` / `user_library_metadata_set` / `user_library_metadata_delete` / `annotate` / `annotate_batch` / `load_image` / `export_canvas` / `canvas_inspect` / `update_element` / `delete_element` / `delete_elements` / `move_elements` / `align_elements` / `distribute_elements` / `canvas_clear` / `assign_to_group` / `delete_group` / `list_groups` / `create_frame` / `update_frame_members` / `viewport_set` / `version_save` / `version_restore` / `version_list`) to create a canvas, draw the diagram, and export it with `export_canvas({ format })` as PNG, SVG, or standard `.excalidraw` JSON.
Open exported PNGs with the Read tool and inspect them visually.

**Open [`references/reading-map.md`](./references/reading-map.md) first and read only the note you need.**
- `references/reading-map.md`: the routing note that tells you which guidance to open for which kind of diagram
- `references/library-first-workflow.md`: how to work library-first for icon-heavy diagrams; open only when needed
- `style-reference.md`: the deep reference for coordinates, color, frames, and layout recipes; open only when needed
- `visual-vocabulary.md`: the deep reference for labeling, diagram choice, and anti-patterns; open only when needed

Do not read `style-reference.md` and `visual-vocabulary.md` end-to-end every time.
Choose the diagram type through the reading map, then open only 1-2 relevant notes.

If you need **the collaborative workflow for tightening the visual together while talking with the user**, also open [`../coauthoring-visuals/SKILL.md`](../coauthoring-visuals/SKILL.md).
This `drawing-visuals` skill covers canvas operations, diagram vocabulary, and drawing mechanics.
`coauthoring-visuals` covers context gathering, frame-by-frame refinement, and fresh-viewer testing.

---

## When To Reach For The Whiteboard

**Do not wait for the user to ask explicitly.**
The moment it feels like "drawing would be faster than prose," propose it and use it.

### Structure And Placement

- explaining screen layout, UI mocks, or component placement
- organizing dependencies and responsibility splits across components or modules
- sharing the big picture of a directory tree or other hierarchy

### Motion And Order

- following a data flow, processing flow, or request path
- explaining state transitions, lifecycle, or event order
- aligning on sequence: who passes what to whom, and when

### Comparison And Diffs

- showing before / after, current / proposal, or option A / option B side by side
- showing an N x M comparison matrix such as environment-by-feature coverage

### Directing Change On Existing Visuals

- annotating screenshots with "change this here" or "this is the problem"
- leaving review comments on design comps or existing screens

### Alignment When Ambiguity Remains

- when a spec or requirement still feels mismatched
- when three rounds of prose still are not converging
- when you think both sides may be saying the same thing but are not confident

**When in doubt, draw.**
The cost of drawing is low; the cost of proceeding under false alignment is high.
If the diagram turns out unnecessary, a quick `canvas_create` can be discarded.

### Explicit User Triggers

- `/drawing-visuals` - export the current canvas and consider the next adjustment
- `/drawing-visuals <canvasId>` - work in the specified canvas
- "explain it as a diagram", "use the whiteboard", "share it visually"

---

## The Loop After You Decide To Draw

This is the working loop after you pick up the whiteboard.
Repeat **draw -> inspect -> fix** until the board converges.

### Step 0: Look For Official Or Saved Libraries First

If the domain depends heavily on icons (AWS / GCP / K8s / network / UML / flowchart and similar), **search the official catalog and saved libraries before hand-drawing rectangles**.
Using established icons improves fidelity and removes needless work around shape and color design.

Open [`references/library-first-workflow.md`](./references/library-first-workflow.md) for the full workflow.
At minimum:

- inspect `user_library_list` and `library_catalog_list`
- if a library looks promising, save it with `user_library_save` and inspect contents with `library_list_items`
- if item names alone are not enough, do a scratch-canvas `trial insert` rather than inserting directly into production
- judge both **identity** and **visual scale**
- save useful index / notes / scale knowledge into `user_library_metadata_set`
- preserve provider icon recognizability and apply brand through labels / frames / legends / palettes instead

You can skip this step for generic rectangle-and-arrow flows, comparison matrices, before/after diffs, and screenshot annotation.
If you cannot rely on a dedicated Claude Code subagent, hand [`references/library-research-prompt-template.md`](./references/library-research-prompt-template.md) to a General Subagent for library research.

### Step 1: State The Intent

Describe the purpose of the diagram in 1-2 lines.
Examples:
- "data flow for feature A -> B -> C"
- "metric comparison matrix for previous vs current"

If the intent is fuzzy, open [`visual-vocabulary.md`](./visual-vocabulary.md), look at "Choose the diagram from the question" and the "intent -> diagram" mapping, and narrow it down to **one question this diagram answers**.
Do not try to solve multiple questions in one **frame or canvas** at once.

Examples of questions that should be separated:
- explain structure
- point out a problem
- compare proposals
- show a historical before / after

The choice of **separate canvases vs multiple frames on one canvas** should follow the guidance in [`visual-vocabulary.md`](./visual-vocabulary.md).
If the diagrams belong to the same discussion, prefer **1 canvas + multiple frames**.
Split into separate canvases only when independent export / sharing / audience separation is needed.

Once the intent is fixed, the drawing tool choice usually becomes obvious:

| Intent | Primary Tools |
| --- | --- |
| domain-specific icon diagram (AWS/GCP/K8s/UML) | `library_catalog_list` -> `user_library_save` -> `library_insert_item` |
| reusable structural components | `template_list` -> `template_insert` |
| flow with rectangles and arrows | `annotate_batch` with `box_with_label` + `arrow` |
| comparison matrix (NxM, same-size cells) | `annotate_batch` with `layout` grid + `box_with_label` |
| comparison table plus extra banner / footer | use **absolute coordinates**, not `layout` grid |
| grouping existing related elements | `annotate_batch` with `group` |
| emphasis / filled background | `annotate` with `rectangle` / `highlight` |
| annotate an existing screenshot | `load_image` -> `annotate` with `coords: relative` |
| one-off label or emphasis | `annotate` |

Once the diagram type is chosen, open the relevant recipe in [`style-reference.md`](./style-reference.md#layout-patterns).
It contains the shell, must-have elements, and common failure points for architecture, sequence, decision tree, directory tree, and comparison matrix patterns.
For vocabulary and visual distinction of main path / exceptions / uncertainty, prefer the guidance in [`visual-vocabulary.md`](./visual-vocabulary.md).

### Step 2: Draw

- **Prefer official libraries for icons**: library items found in Step 0 can be inserted repeatedly anywhere with `library_insert_item`. This often communicates more with less effort than a rectangle-and-text substitute
- **Prefer templates for reusable parts**: inspect with `template_list`, place with `template_insert`, then adjust the inserted elements with `update_element` / `move_elements`
- **Fit the viewport after drawing**: call `viewport_set({ mode: "fit", padding: 40 })` so the whole composition is visible instead of leaving the browser on the default origin/zoom
- **Use `annotate_batch` for multiple elements**: this is cheaper and cleaner than many individual `annotate` calls
- **Long text wraps automatically by default (`autoFit: true`)**: `box_with_label` wraps long lines on whitespace and expands height as needed. Even if you pass `string[]`, long lines inside each entry can still wrap further. Use `autoFit: false` only when you need strict line control
- **Colors are hex**: pass `#RRGGBB` for `color` / `backgroundColor` on `annotate` / `annotate_batch`
- **Use plain `text` with `width` when you want wrapped headings or notes**
- **Split `box_with_label` content into `title` / `text` / `subText`**: use `title` for emphasis, push supporting detail into `subText`, and use `subTextPosition: "top"` only when the caption truly belongs outside the rect
- **For uneven matrix columns / rows**: use `layout.colWidths`, `layout.rowHeights`, `rowSpan`, `colSpan`, and inspect `dryRun: true` before committing
- **Always inspect `annotate_batch` warnings**: `overflow`, `autoExpandedBy`, and overlap warnings are early signals that spacing is too tight
- **For arrows between boxes**: prefer `startBoxId` / `endBoxId` or the equivalent name-based attachment so the arrow snaps to box edges
- **For horizontal DAGs with fork/merge diamonds**: long arrows often cut through intermediate boxes. Instead, route them around boxes with a 3-point polyline plus smooth curve:

```js
update_element({
  elementId: arrowId,
  patch: {
    points: [[0, 0], [midX, delta], [endX, 0]],
    width: endX,
    height: Math.abs(delta),
    roundness: { type: 2 }
  }
})
```

  - use `delta = -boxH` for upper-band arrows and `delta = +boxH` for lower-band arrows
  - keep label width within roughly 110px including margin; if it overflows, shorten or split it to two lines
  - for large DAG-heavy sections, wrap them in `create_frame` and iterate with `export_canvas({ format: "png", frameId })`
- **Template variables**: use `template_insert({ variables: { service: "Billing API" } })` to substitute placeholders such as `{{service}}`
- **Use frames for large diagrams**: if the canvas grows past a few screens, group related content with `create_frame`. This also enables section-level `export_canvas({ format: "png", frameId })`
- **For related questions such as `current / problem / proposal`, think in frames first**: on an infinite Excalidraw canvas, related frames are easier to compare than separate canvases
- **Treat frame names as section headings**: if the frame is named `Current` / `Problem` / `Proposal`, do not repeat the same heading inside it. Use the large text inside the frame for the conclusion or claim
- **For review directions on an existing web UI, use `create_embed`**: embed the URL, then layer arrows / highlights with `annotate`
- **Use `reorder_elements` for z-order fixes**: push annotations to front when labels disappear behind embeds or other elements

### Step 3: Export To PNG And Inspect Visually

```js
export_canvas({ canvasId, format: "png" })
// For large diagrams where small text gets crushed:
export_canvas({ canvasId, format: "png", scale: 2, minFontPx: 16, padding: 32 })
// For inspecting only one section on a large canvas:
export_canvas({ canvasId, format: "png", frameId: "<frame-id>", padding: 24 })
```

`export_canvas` is the single tool for every export format — pass `format: "png"`, `"svg"`, or `"json"`. PNG waits briefly for the browser to settle after opening, but it does **not** automatically open the canvas; SVG and JSON always render headless from the persisted document.
If you need reliable PNG export for a disconnected canvas, call `canvas_open({ waitForClient: true })` first.

Options (PNG/SVG unless noted):
- `padding`: whitespace around elements in px, default 10
- `scale`: PNG only. Export DPI multiplier, default 1
- `minFontPx`: PNG only. Boosts font size only in the export clone
- `frameId`: exports only the frame plus its child elements
- `outputPath`: absolute path to write the file to. When omitted, write to the workspace exports dir
- `overwrite`: replace an existing file at `outputPath`. Default false; without it an existing file rejects with `output_exists`
- `theme`: `"light"` or `"dark"`. Forces the rendered scene into the chosen theme without mutating persisted state. Pair both runs (`outputPath: ".../foo-light.png"` + `theme: "light"` and `.../foo-dark.png` + `theme: "dark"`) when reviewing dark-mode contrast or shipping diagrams that may live in mixed themes
- `includeCustomFields`: JSON only. Keep internal custom fields (`parentId` / `relX` / `relY`) in the exported JSON. Default false, which resolves them into absolute x/y — use this to round-trip through excalidraw.com or the desktop app

Inspect the exported PNG visually:

- is text overflowing out of boxes?
- do arrows connect to the intended targets?
- does the main subject read without reading every arrow label?
- are frame names and inner section headings duplicated?
- are colors distinct and legible enough?
- are gaps between cells / blocks wide enough?

If the PNG is too large and the Read tool would burn too much context, optimize in this order:

1. export only the relevant `frameId`
2. lower `scale` to `0.5` or `0.7` if text remains legible
3. switch to a viewport screenshot via browser tooling if needed

To use `frameId`, set up frames in Step 2 with `create_frame({ canvasId, memberIds, name })` so section-level export stays available across iterations.

### Step 4: Use `canvas_inspect` To Check Structure

If the diagram looks wrong but the reason is unclear:

```js
canvas_inspect({ canvasId })
```

This returns each element's id / type / x,y / width,height / containerId.
Use it to inspect things like broken box-label binding or unintended z-order.

### Step 5: Fine-Tune Or Redraw

The goal is not to minimize edit count.
The goal is to restore correct shared understanding.
If the issue is small, fine-tuning is enough.
If the structure, layout, or intent itself is suspect, **create a new canvas and redraw without hesitation**.

| Situation | Best Action |
| --- | --- |
| change text, color, or font size | `update_element({ elementId, patch: { ... } })` |
| move one or many elements | `move_elements({ elementIds, dx, dy })` |
| align a few sibling boxes to a shared edge or centre | `align_elements({ elementIds, alignment })` — `left` / `right` / `center` for x; `top` / `bottom` / `middle` for y; orthogonal axis untouched |
| even out the spacing of three or more elements along a row or column | `distribute_elements({ elementIds, direction })` — `horizontal` along x, `vertical` along y; first and last stay fixed |
| delete one unnecessary element | `delete_element({ elementId })` |
| delete many unnecessary elements together | `delete_elements({ elementIds })` |
| delete and rebuild a whole section | pre-group with `assign_to_group`, then remove with `delete_group` |
| clear the entire canvas | `canvas_clear({ canvasId })` |
| overall layout is wrong | rebuild using a corrected `annotate_batch` layout |
| structure or intent is wrong | redraw from scratch on a new canvas, or recreate intentionally with `canvas_create({ ..., overwrite: true })` when replacing a known target |
| the real comparison axis changed mid-drawing | redraw on a new canvas instead of force-mutating the old one |

#### Section Replacement Workflow

In long design canvases with 10+ sections, it is common to rewrite only one section.
Calling `delete_element` 20-30 times is slow and error-prone.
Use a logical group instead:

```js
// 1. After the first draw, assign the returned elementIds to a logical group
assign_to_group({
  canvasId,
  groupId: "sec-11-after",
  elementIds: [/* ids */]
})

// 2. Later, delete the whole section in one shot
delete_group({ canvasId, groupId: "sec-11-after" })

// 3. Redraw the new section and reassign the same groupId
const { elementIds } = await annotate_batch({ ... })
assign_to_group({ canvasId, groupId: "sec-11-after", elementIds })
```

- inspect existing groups with `list_groups({ canvasId })`
- give `groupId` a meaningful kebab-case name such as `sec-11-before`, `sec-11-after`, or `merge-dialog-wireframe`
- one element can belong to multiple groups
- for frames: `create_frame({ memberIds })` auto-fits only at creation time. If you add new elements later, pull them in with `update_frame_members({ frameId, add: [...] })` so the `frameId` stays stable for future `export_canvas({ format: "png", frameId })`

After each fix, go back to Step 3 and export again.
Redrawing is normal whiteboard behavior, not failure.

---

## Checklist When You Are Unsure

- [ ] if the domain uses specific icons, did you check `library_catalog_list` / `user_library_list` first?
- [ ] did you write down the one question the diagram should answer before drawing?
- [ ] did you choose the diagram family from [`visual-vocabulary.md`](./visual-vocabulary.md)?
- [ ] if multiple questions belong to the same discussion, did you consider frames before separate canvases?
- [ ] if the frame name already acts as a section heading, did you avoid duplicating it inside the frame?
- [ ] did you bundle multiple elements into one `annotate_batch`?
- [ ] did you pre-split long labels with `string[]` when needed?
- [ ] did you use semantic color keys?
- [ ] can the main path / supporting info / problem / proposal / uncertainty be distinguished visually?
- [ ] are arrow labels duplicating what box titles or callouts already say?
- [ ] did you visually inspect with `export_canvas` and inspect structure with `canvas_inspect`?
- [ ] did you use `update_element` / `move_elements` / `delete_element` for local fixes?
- [ ] if structure or intent needed rethinking, did you redraw on a new canvas instead of forcing the old one to fit?

---

## Notes

- **Browser Ctrl+Z / undo buttons only revert GUI edits made in the browser itself**: browser undo delegates to the Loro UndoManager. That is collaboration-safe, but MCP-originated changes arrive as remote changes, so browser undo will not rewind them. If you need to rewind tool-driven work, save a `version_save({ canvasId, label })` before the risky edit and call `version_restore({ canvasId, versionId })` (or `version_restore` with `targetSlug` to fork into a new canvas instead of reconciling in place)
- **whiteboard MCP is a local dev tool**: outputs under `~/.whiteboard/` are outside git. If you need a PNG in a PR or other artifact, copy the exported file explicitly
- **Wrapping behavior**: `text` wraps automatically when `width` is provided. `box_with_label` auto-fits by default and keeps explicit `string[]` line breaks. Use `autoFit: false` only when you truly need rigid line control
- **Known stale-snapshot constraint**: if another client is editing at the same time, `annotate` coordinates can occasionally be based on an older snapshot. In local single-user practice the timing window is short and usually harmless
