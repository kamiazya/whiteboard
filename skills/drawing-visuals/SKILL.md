---
name: drawing-visuals
description: Draw diagrams with your AI agent on a shared JSON Canvas whiteboard. Use it when screen layout, structure, flow, or comparison still feels too ambiguous in text alone. Covers node/edge editing and SVG rendering only — no icon libraries, no other export formats.
---

# drawing-visuals

Like a whiteboard on the wall of a meeting room, this is a tool for AI and humans to **align by drawing on the same workspace**.
Use it when drawing and pointing is faster than iterating in prose.
What you draw stays on the document and can be revisited and refined later.

**Coverage note.** The whiteboard MCP surface is deliberately small: edit nodes and edges,
tidy the layout, render SVG, save/restore versions. There is no icon or template library, no
align/distribute, and no viewport control. Plan the diagram with that ceiling in mind rather than
assuming a full-featured drawing-app tool set.

Use these tools:

- `wb_document_create` / `wb_document_list` / `wb_document_resolve` / `wb_document_delete` — create, find, and remove documents
- `wb_canvas_edit` — **the whole spatial-editing surface.** One call takes a list of ops (add, patch, remove, lock, tidy) and applies them as a single transaction
- `wb_canvas_snapshot` — read what is on a canvas: node types, text, geometry and lock state, plus every edge
- `wb_scene_render` — render the laid-out scene as SVG (the only export format)
- `wb_scene_digest` — the laid-out geometry (overlaps, clusters, free regions), for judging whether a board is tidy
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

**Draw the whole diagram in one `wb_canvas_edit` call.** The ops apply in order as a single
transaction: either all of them land or none does, and a refusal names the op that failed by index.
Do not issue one call per node.

```js
wb_canvas_edit({
  workspaceId, documentId,
  ops: [
    { op: "node.add", node: { id: "client", type: "text", text: "Client", color: "#1971c2" } },
    { op: "node.add", node: { id: "server", type: "text", text: "Server" } },
    { op: "edge.add", edge: { id: "req", fromNode: "client", toNode: "server", label: "request", toEnd: "arrow" } },
  ],
})
```

**Geometry is optional.** A node with no `x`/`y`/`width`/`height` is placed for you in a grid below
whatever is already on the board, and the position chosen comes back under `geometry`. Supply
coordinates only when the layout itself carries meaning — a comparison matrix, a deliberate
left-to-right flow. For everything else, let placement happen and finish with a `tidy` op.

`color` is either a hex string like `#1971c2` or a JSON Canvas preset `"1"`-`"6"`; there is no
semantic color name like `"primary"`. There is no auto-wrap, so if you do set a width, pick one
generous enough for the label.

Edges reference node ids, not coordinates — an `edge.add` fails if either endpoint is not on the
canvas by the time that op runs. A node added EARLIER IN THE SAME CALL counts, which is why ids are
worth naming yourself. `fromSide`/`toSide` (`top`/`right`/`bottom`/`left`) and `fromEnd`/`toEnd`
(`none`/`arrow`) are the only routing hints; `wb_scene_render` computes the actual drawn path.

**Ids you omit are minted for you** and reported under `touched`. Name them yourself for any node an
edge has to reach.

**Adds never overwrite.** An `add` whose id is already on the canvas fails the whole batch — use a
`node.patch` / `edge.patch` op to change something already placed.

**If you set coordinates, use a rigid grid.** Do not hand-calculate case by case: pick
`column * 220 + 40` for x and `row * 140 + 40` for y (or similar), assign a row/column to every node,
then fill in the numbers. See [`style-reference.md`](./style-reference.md) for sizing and color
guidance.

### Step 4: Tidy And Render

Tidy is an op, so it usually belongs at the END of the same call that drew the diagram rather than
in a call of its own:

```js
wb_canvas_edit({ workspaceId, documentId, ops: [ /* ...adds... */, { op: "tidy" } ] })

// Re-tidy only a subset, leaving everything else as a fixed obstacle:
wb_canvas_edit({ workspaceId, documentId, ops: [{ op: "tidy", scope: ["client", "server"] }] })

wb_scene_render({ workspaceId, documentId })
// Resolve `file` node references (e.g. a node that embeds another document) inline:
wb_scene_render({ workspaceId, documentId, embedReferences: true })
```

The `tidy` op re-lays-out node positions automatically; it has no `direction`, `pins`, or `groups`
parameters — it is a one-shot auto-arrange, not a configurable layout engine. It refuses a markdown
document (there is nothing spatial to tidy) and treats a locked node as fixed. Whatever it moved
comes back under `geometry`.

`wb_scene_render` returns `{ svg, width, height }` — SVG is the only rendered export format, and
there is no way to render only one section of the document; the whole canvas renders every time.
Open the returned SVG (or write it to a file and view it) to inspect it visually:

- is text overflowing out of boxes? (there is no auto-wrap, so this is a real risk)
- do edges connect to the intended nodes?
- does the main subject read without reading every edge label?
- are colors distinct and legible enough?
- are gaps between nodes wide enough?

If you cannot see the rendered image, read the board instead. The two reads answer different
questions and neither replaces the other:

- `wb_canvas_snapshot({ workspaceId, documentId })` — **what is on the board**: each node's type,
  text, geometry and lock state, plus every edge. Long text and very large boards are cut, and the
  real totals come back alongside so a capped read never looks complete.
- `wb_scene_digest({ workspaceId, documentId })` — **whether the board is tidy**: laid-out geometry,
  overlaps, clusters and free regions. It carries no text at all.

You rarely need either right after an edit: `wb_canvas_edit` already returns the resulting board
under `snapshot`.

### Step 5: Fine-Tune Or Redraw

Every one of these is an op inside a `wb_canvas_edit` call, and several can travel together:

| Situation | Op |
| --- | --- |
| change a node's position, size, color, or label | `{ op: "node.patch", id, patch: { ... } }` |
| change an edge's endpoints, sides, arrowheads, color, or label | `{ op: "edge.patch", id, patch: { ... } }` |
| remove a node | `{ op: "node.remove", id }` — its edges go with it |
| remove an edge | `{ op: "edge.remove", id }` |
| protect a node/edge from further edits (by anyone) | `{ op: "node.lock", id, locked: true }` / `{ op: "edge.lock", ... }` |
| re-run automatic layout | `{ op: "tidy" }` (optionally scoped) |
| structure or intent is wrong | create a fresh document with `wb_document_create` and redraw |

**A lock binds you too.** A `patch` or `remove` on a locked element fails the batch. Unlocking is the
one op a locked element still accepts, so you can lift your own lock in the same call:
`[{ op: "node.lock", id: "x", locked: false }, { op: "node.patch", id: "x", patch: { x: 40 } }]`.

Pruning is cheap now, so plan placement normally rather than defensively — but prefer redrawing on a
fresh document when the STRUCTURE is wrong, not just a few elements.

After each fix, go back to Step 4 and render again.
Redrawing on a fresh document is normal whiteboard behavior when the structure is wrong, not failure.

---

## Checklist When You Are Unsure

- [ ] did you write down the one question the diagram should answer before drawing?
- [ ] did you choose the diagram family from [`visual-vocabulary.md`](./visual-vocabulary.md)?
- [ ] did you draw the whole diagram in ONE `wb_canvas_edit` call rather than one call per node?
- [ ] if you set coordinates at all, did you plan a rigid grid — or let placement happen and finish with a `tidy` op?
- [ ] if you set widths, did you size boxes generously, since there is no auto-wrap?
- [ ] did you use semantic, consistent colors even though the tool has no named color keys?
- [ ] can the main path / supporting info / problem / proposal be distinguished visually?
- [ ] are edge labels duplicating what node text already says?
- [ ] did you render with `wb_scene_render` (or read the board with `wb_canvas_snapshot`) and inspect it?
- [ ] if structure or intent needed rethinking, did you redraw on a new document instead of trying to prune the old one?

---

## Notes

- **Every write is a remote change.** MCP tool calls apply directly to the document; there is no
  separate "commit" step and no local undo. One `wb_canvas_edit` call is atomic — a rejected batch
  leaves nothing behind — but a batch that SUCCEEDS is not undoable, so save a
  `wb_version_save({ documentId, label })` before a risky one and call
  `wb_version_restore({ workspaceId, documentId, versionId })` to roll back if it goes wrong.
- **whiteboard MCP is a local dev tool**: documents live under `~/.whiteboard/`, outside git. If you
  need the SVG in a PR or other artifact, save the string `wb_scene_render` returns to a file.
- **A document's format is fixed at creation.** `kind: "spatial"` gives you nodes and edges;
  `kind: "markdown"` gives you an OKF Markdown body edited through `wb_document_set` / `wb_body_patch`
  and has no nodes or edges of its own. There is no format parameter on read — `wb_document_get`
  answers in whichever format the document already is.
