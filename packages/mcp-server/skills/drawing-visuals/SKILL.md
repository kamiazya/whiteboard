---
name: drawing-visuals
description: Draw diagrams with your AI agent on a shared JSON Canvas whiteboard. Use it when screen layout, structure, flow, or comparison still feels too ambiguous in text alone. Covers node/edge placement and SVG rendering only — no icon libraries, no other export formats, no per-element delete.
---

# drawing-visuals

Like a whiteboard on the wall of a meeting room, this is a tool for AI and humans to **align by drawing on the same workspace**.
Use it when drawing and pointing is faster than iterating in prose.
What you draw stays on the document and can be revisited and refined later.

**Coverage note.** The whiteboard MCP surface is deliberately small: place nodes and edges,
tidy the layout, render SVG, save/restore versions. There is no icon or template library, no
align/distribute, no viewport control, and — today — no way to delete a single node or edge once
added. Plan the diagram with that ceiling in mind rather than assuming a full-featured drawing-app
tool set.

Use these tools:

- `wb_document_create` / `wb_document_list` / `wb_document_resolve` / `wb_document_delete` — create, find, and remove documents
- `wb_node_add` / `wb_node_patch` / `wb_node_lock` — place and adjust nodes
- `wb_edge_add` / `wb_edge_patch` / `wb_edge_lock` — connect nodes
- `wb_canvas_tidy` — auto re-layout
- `wb_scene_render` — render the laid-out scene as SVG (the only export format)
- `wb_scene_digest` — a text summary of the scene, for when you cannot see the rendered image
- `wb_version_save` / `wb_version_list` / `wb_version_restore` — checkpoint and roll back

**Open [`references/reading-map.md`](./references/reading-map.md) first and read only the note you need.**
- `references/reading-map.md`: the routing note that tells you which guidance to open for which kind of diagram
- `style-reference.md`: the deep reference for coordinates, color, and layout recipes; open only when needed
- `visual-vocabulary.md`: the deep reference for labeling, diagram choice, and anti-patterns; open only when needed

Do not read `style-reference.md` and `visual-vocabulary.md` end-to-end every time.
Choose the diagram type through the reading map, then open only 1-2 relevant notes.

If you need **the collaborative workflow for tightening the visual together while talking with the user**, also open [`../coauthoring-visuals/SKILL.md`](../coauthoring-visuals/SKILL.md).
This `drawing-visuals` skill covers canvas operations, diagram vocabulary, and drawing mechanics.
`coauthoring-visuals` covers context gathering, iterative refinement, and fresh-viewer testing.

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

### Alignment When Ambiguity Remains

- when a spec or requirement still feels mismatched
- when three rounds of prose still are not converging
- when you think both sides may be saying the same thing but are not confident

**When in doubt, draw.**
The cost of drawing is low; the cost of proceeding under false alignment is high.
If the diagram turns out unnecessary, `wb_document_delete` it.

### Explicit User Triggers

- `/drawing-visuals` - render the current document and consider the next adjustment
- `/drawing-visuals <documentId>` - work in the specified document
- "explain it as a diagram", "use the whiteboard", "share it visually"

---

## The Loop After You Decide To Draw

Repeat **draw -> render -> fix** until the document converges.

### Step 1: State The Intent

Describe the purpose of the diagram in 1-2 lines.
Examples:
- "data flow for feature A -> B -> C"
- "metric comparison matrix for previous vs current"

If the intent is fuzzy, open [`visual-vocabulary.md`](./visual-vocabulary.md), look at "Choose the diagram from the question", and narrow it down to **one question this diagram answers**.
Do not try to answer multiple questions in one document at once — there is no section-level export, so a document either reads as one story or it reads as clutter.

Once the intent is fixed, choose the node shape that fits:

| Content | Node type |
| --- | --- |
| a labeled box, the default building block | `text` (has a plain `text` string; no rich formatting, no auto-wrap) |
| a reference to another document, image, or file | `file` |
| a link out to a URL | `link` |
| a lightweight visual boundary (label + background) | `group` |

### Step 2: Create The Document

```js
wb_document_create({ workspaceId, path: "diagrams/checkout-flow", kind: "spatial", name: "Checkout flow" })
```

`kind: "spatial"` is required and cannot change later — a document is either a JSON Canvas (spatial) or OKF Markdown, decided at creation.

### Step 3: Place Nodes And Edges

Every node needs an id, integer `x`/`y`/`width`/`height`, and an optional `color` (either a hex string
like `#1971c2` or a JSON Canvas preset `"1"`-`"6"` — there is no semantic color name like `"primary"`).
There is no auto-sizing or auto-wrap: pick a width generous enough for the label up front.

```js
wb_node_add({
  workspaceId, documentId,
  node: { id: "client", type: "text", x: 40, y: 40, width: 160, height: 60, text: "Client", color: "#1971c2" },
})
wb_node_add({
  workspaceId, documentId,
  node: { id: "server", type: "text", x: 320, y: 40, width: 160, height: 60, text: "Server" },
})
wb_edge_add({
  workspaceId, documentId,
  edge: { id: "req", fromNode: "client", toNode: "server", label: "request", toEnd: "arrow" },
})
```

Edges reference node ids, not coordinates — `wb_edge_add` fails if either endpoint does not already
exist on the canvas. There is no coordinate math to do for the edge itself: `fromSide`/`toSide`
(`top`/`right`/`bottom`/`left`) and `fromEnd`/`toEnd` (`none`/`arrow`) are the only routing hints, and
`wb_scene_render` computes the actual drawn path.

**Fails if the id is taken.** `wb_node_add` / `wb_edge_add` never overwrite an existing id — use
`wb_node_patch` / `wb_edge_patch` to change something already placed.

**Use a rigid grid.** Do not hand-calculate coordinates case by case. Pick `column * 220 + 40` for x
and `row * 140 + 40` for y (or similar), assign a row/column to every node, then fill in the numbers.
See [`style-reference.md`](./style-reference.md) for sizing and color guidance.

### Step 4: Tidy And Render

```js
wb_canvas_tidy({ workspaceId, documentId })
// Re-tidy only a subset, leaving everything else as a fixed obstacle:
wb_canvas_tidy({ workspaceId, documentId, scope: ["client", "server"] })

wb_scene_render({ workspaceId, documentId })
// Resolve `file` node references (e.g. a node that embeds another document) inline:
wb_scene_render({ workspaceId, documentId, embedReferences: true })
```

`wb_canvas_tidy` re-lays-out node positions automatically; it has no `direction`, `pins`, or `groups`
parameters — it is a one-shot auto-arrange, not a configurable layout engine. It refuses a markdown
document (there is nothing spatial to tidy) and treats a locked node (see `wb_node_lock`) as fixed.

`wb_scene_render` returns `{ svg, width, height }` — SVG is the only rendered export format, and
there is no way to render only one section of the document; the whole canvas renders every time.
Open the returned SVG (or write it to a file and view it) to inspect it visually:

- is text overflowing out of boxes? (there is no auto-wrap, so this is a real risk)
- do edges connect to the intended nodes?
- does the main subject read without reading every edge label?
- are colors distinct and legible enough?
- are gaps between nodes wide enough?

If you cannot see the rendered image, call `wb_scene_digest({ workspaceId, documentId })` instead —
it summarizes the laid-out scene (node/edge counts, bounding boxes, and similar) as structured data.

### Step 5: Fine-Tune Or Redraw

| Situation | Best Action |
| --- | --- |
| change a node's position, size, color, or label | `wb_node_patch({ nodeId, patch: { ... } })` |
| change an edge's endpoints, sides, arrowheads, color, or label | `wb_edge_patch({ edgeId, patch: { ... } })` |
| protect a node/edge from further edits (by anyone) | `wb_node_lock` / `wb_edge_lock` |
| re-run automatic layout | `wb_canvas_tidy` (optionally scoped) |
| structure or intent is wrong | create a fresh document with `wb_document_create` and redraw |

**There is no delete tool for a single node or edge.** Once placed, a node or edge stays on the
document; the only way to "remove" it today is to `wb_node_patch` it into something harmless (a
small notice) or to start over with a new document via `wb_document_create`. Plan placement
conservatively rather than expecting to prune afterward.

After each fix, go back to Step 4 and render again.
Redrawing on a fresh document is normal whiteboard behavior when the structure is wrong, not failure.

---

## Checklist When You Are Unsure

- [ ] did you write down the one question the diagram should answer before drawing?
- [ ] did you choose the diagram family from [`visual-vocabulary.md`](./visual-vocabulary.md)?
- [ ] did you plan a rigid coordinate grid before calling `wb_node_add`?
- [ ] did you size boxes generously, since there is no auto-wrap?
- [ ] did you use semantic, consistent colors even though the tool has no named color keys?
- [ ] can the main path / supporting info / problem / proposal be distinguished visually?
- [ ] are edge labels duplicating what node text already says?
- [ ] did you render with `wb_scene_render` (or summarize with `wb_scene_digest`) and inspect it?
- [ ] if structure or intent needed rethinking, did you redraw on a new document instead of trying to prune the old one?

---

## Notes

- **Every write is a remote change.** MCP tool calls apply directly to the document; there is no
  separate "commit" step and no local undo. Save a `wb_version_save({ documentId, label })` before a
  risky batch of edits and call `wb_version_restore({ workspaceId, documentId, versionId })` to roll
  back if it goes wrong.
- **whiteboard MCP is a local dev tool**: documents live under `~/.whiteboard/`, outside git. If you
  need the SVG in a PR or other artifact, save the string `wb_scene_render` returns to a file.
- **A document's format is fixed at creation.** `kind: "spatial"` gives you nodes and edges;
  `kind: "markdown"` gives you an OKF Markdown body edited through `wb_document_set` / `wb_body_patch`
  and has no nodes or edges of its own. There is no format parameter on read — `wb_document_get`
  answers in whichever format the document already is.
