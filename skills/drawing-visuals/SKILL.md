---
name: drawing-visuals
description: Draw diagrams with your AI agent on a shared JSON Canvas whiteboard. Use it when screen layout, structure, flow, or comparison still feels too ambiguous in text alone. Covers node/edge editing, shapes and stencils, tags, and SVG rendering — SVG is the only export format.
---

# drawing-visuals

Like a whiteboard on the wall of a meeting room, this is a tool for AI and humans to **align by drawing on the same workspace**.
Use it when drawing and pointing is faster than iterating in prose.
What you draw stays on the document and can be revisited and refined later.

**Coverage note.** The whiteboard MCP surface is deliberately small: edit nodes and edges,
dress them (a silhouette, a stencil, a tag), tidy the layout, render SVG, save/restore versions.
There is no align/distribute and no artwork to insert; what draws a box differently is a facet
(see "Shapes, Stencils And Tags" below). `wb_viewport_set` exists, but through this stdio entry it answers
`delivered: false`, because no browser is in the same process: do not promise the user that the
view moved, tell them to look at the document (an open tab picks your edit up within about half a
second, but it stays where it is). Plan the diagram with that ceiling in mind
rather than assuming a full-featured drawing-app tool set.

Use these tools:

- `wb_workspace_edit` — create, replace, move and delete documents in one call (`document.create` / `document.set` / `document.move` / `document.delete` ops)
- `wb_document_list` — find documents (each row carries the id and the path, so an id needs no second call to place)
- `wb_canvas_edit` — **the whole spatial-editing surface.** One call takes a list of ops (add, patch, remove, lock, tidy) and applies them as a single transaction. **Pass `mode: "apply"`**: the default proposes content changes for a person to adopt, because nobody watches an agent type (read it back with `wb_document_get`'s `proposals`: each change says whether it is still open, was adopted or was dismissed) — but somebody just asked you to draw this, and they are looking at it
- `wb_canvas_snapshot` — read a canvas: node types, text, geometry, lock state, facets and tags, plus every edge with its bends, facets and tags. Pass `layout: true` to also get the laid-out analysis (overlaps, clusters, free regions) for judging whether the board is tidy
- `wb_scene_render` — render the laid-out scene as SVG (the only export format)
- `canvas_view` — show a canvas inline in the chat, read-only, in a client that renders MCP Apps
- `wb_facet_list` — list what a write may name: the facets, the stencil / icon / theme ids, and with `workspaceId` the workspace's own stencils, the tags it uses and its tag library
- `wb_facet_set` — tag a document, board, node or edge, or set a facet on one
- `wb_document_search` — find documents by what they say or by a tag
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
If the diagram turns out unnecessary, delete it with a `wb_workspace_edit` `document.delete` op.

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
Do not try to answer multiple questions in one document at once — a document either reads as one story or it reads as clutter, and although `wb_scene_render` can draw one group on its own (`fragment`), a reader opening the document still meets all of it.

Once the intent is fixed, choose the node shape that fits:

| Content | Node type |
| --- | --- |
| a labeled box, the default building block | `text` (its `text` is Markdown — a heading, bold, a bullet or `- [ ]` task, a fenced code block — and wraps at the width; omit the height and the box is sized to its text) |
| a reference to another document, image, or file | `file` |
| a link out to a URL | `link` |
| a lightweight visual boundary (label + background) | `group` |

A node's kind of content is not its silhouette: a decision, a datastore or a queue is still a
`text` node, drawn differently by a facet or a stencil — see "Shapes, Stencils And Tags" below.

### Step 2: Create The Document

```js
wb_workspace_edit({ workspaceId, ops: [{ op: "document.create", path: "diagrams/checkout-flow", kind: "spatial", name: "Checkout flow" }] })
```

`workspaceId` is `default` unless the user names another workspace: it is the segment of the first workspace a data directory gets, which is also the one the web app opens first. No tool lists workspaces, so an id you were not given is an id you do not have. A workspace that does not exist yet is an error unless the call carries `createWorkspace: true`.

`kind: "spatial"` is required and cannot change later — a document is either a JSON Canvas (spatial) or OKF Markdown, decided at creation.

### Step 3: Place Nodes And Edges

**Draw the whole diagram in one `wb_canvas_edit` call.** The ops apply in order as a single
transaction: either all of them land or none does, and a refusal names the op that failed by index.
Do not issue one call per node.

```js
wb_canvas_edit({
  workspaceId, documentId,
  // Somebody asked for this drawing and is waiting to see it, so it applies.
  // Without a mode a batch of content is stored as a PROPOSAL instead, which
  // is the right default when nobody asked (ADR-0029 decision 3).
  mode: "apply",
  ops: [
    { op: "node.add", node: { id: "client", type: "text", text: "Client", color: "#1971c2" } },
    { op: "node.add", node: { id: "server", type: "text", text: "Server" } },
    { op: "edge.add", edge: { id: "req", from: { node: "client" }, to: { node: "server", end: "arrow" }, label: "request" } },
  ],
})
```

**Geometry is optional.** A node with no `x`/`y`/`width`/`height` is placed for you in a grid below
whatever is already on the board, and the position chosen comes back under `geometry`. Supply
coordinates only when the layout itself carries meaning — a comparison matrix, a deliberate
left-to-right flow. For everything else, let placement happen and finish with a `tidy` op.

`color` is either a hex string like `#1971c2` or a JSON Canvas preset `"1"`-`"6"`; there is no
semantic color name like `"primary"`. Text wraps at the box's width but the box never grows on its
own: omit `height` and a text box is made tall enough for its text, while a height you name that is
too short for the text is refused with the height it needs — so name a height only when you know it
holds the text, or leave it out.

Edges reference node ids, not coordinates — an `edge.add` fails if either endpoint is not on the
canvas by the time that op runs. A node added EARLIER IN THE SAME CALL counts, which is why ids are
worth naming yourself. An edge's two ends are the objects `from` and `to`, each `{ node, side?, end? }`:
`end` (`none`/`arrow`) sets the arrowhead at that end, and `side`
(`top`/`right`/`bottom`/`left`) exists but is best left out: the router picks the side that keeps
the line clear of the other boxes, and a side you name is kept even when it runs the line through
one — a `bottom`/`top` pair on an edge between two boxes on the SAME row loops under both and
tunnels back through its own source. `wb_scene_render` computes the actual drawn path.

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
wb_canvas_edit({ workspaceId, documentId, mode: "apply", ops: [ /* ...adds... */, { op: "tidy" } ] })

// Re-tidy only a subset, leaving everything else as a fixed obstacle:
wb_canvas_edit({ workspaceId, documentId, mode: "apply", ops: [{ op: "tidy", scope: ["client", "server"] }] })

wb_scene_render({ workspaceId, documentId })
// Draw what the document references: a `file` node's target inside the node (a
// markdown document as its body, a canvas as a miniature), and any `![[path]]`
// embed inside a markdown body — including the `#Heading` / `#Group label` part
// it names. Off, an embed renders as its address.
wb_scene_render({ workspaceId, documentId, embedReferences: true })
// One part only: a group by its label on a canvas, or a heading's section of a
// markdown document — the same names `[[path#...]]` addresses.
wb_scene_render({ workspaceId, documentId, fragment: "Launch" })
// The look. Default is the bundled one whatever the document says, so a read
// never pays for a theme's jitter or glow unasked; "document" draws the theme
// the canvas names (`visual.theme/v0`, set with wb_facet_set's canvas target);
// a theme id such as "visual.sketch" previews one without storing it.
wb_scene_render({ workspaceId, documentId, style: "document" })
```

The `tidy` op re-lays-out node positions automatically; it has no `direction`, `pins`, or `groups`
parameters — it is a one-shot auto-arrange, not a configurable layout engine. It tidies inside a
group as well: members separate and line up within it, and the group grows (never shrinks) to hold
them with a 32px margin — `within: "<group id>"` scopes it to one group's members. It also orders a
row by its edges: a box whose connections along its row all lie to one side of it is swapped with the
nearest of them, so a box that fans out sits between the boxes it fans out to. It refuses a
markdown document (there is nothing spatial to tidy) and treats a locked node as fixed. Whatever it
moved comes back under `geometry`, a grown group with its new size.

`wb_scene_render` returns `{ svg, width, height }` — SVG is the only rendered export format. It
renders a markdown document too, as a page. `fragment` is the only way to render less than the
whole document, and it addresses a group by label or a heading by text, never a region.
Open the returned SVG (or write it to a file and view it) to inspect it visually:

- is text overflowing out of boxes? (a write naming a height too short for its text is refused, so
  this is a box resized by hand in the editor; omit the height and the box is sized to its text)
- do edges connect to the intended nodes?
- does the main subject read without reading every edge label?
- are colors distinct and legible enough?
- are gaps between nodes wide enough? Keep at least 32px between neighbours — under that an edge
  between them has no room for its label or arrowhead, and inserting a box into a gap the size of a
  box means moving the neighbour over, not squeezing the box in

If you cannot see the rendered image, read the board instead. The two reads answer different
questions and neither replaces the other:

`wb_canvas_snapshot({ workspaceId, documentId })` answers **what is on the board**: each node's
type, text, geometry, lock state, `facets` (its shape, its stencil) and `tags`, plus every edge with
its `bends`, `facets` and `tags`. So read the snapshot to learn how a board is dressed, not only
what it says. Long text and very large boards are cut, and the real totals come back alongside so
a capped read never looks complete.

Add `layout: true` to also get **whether the board is tidy** — overlaps, containment, clusters and
free regions, from the laid-out scene. It costs a layout pass, so ask for it when you are judging
composition rather than reading content.

You rarely need either right after an edit: `wb_canvas_edit` already returns the resulting board
under `snapshot`.

**To let the person see the board without leaving the chat**, call
`canvas_view({ workspaceId, documentId })`. In a client that renders MCP Apps it shows the stored
board inline, read-only and pannable, with a markdown document a node references drawn inside that
node. It draws what is stored, so call it after the edit lands; a client without MCP Apps support
only receives the scene as data, in which case give the person the document's path.

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
| make a group's contents match a list exactly | `{ op: "region.set", within: groupId, nodes, edges }` |
| put boxes that already exist in a NEW group | `{ op: "node.add", node: { type: "group", label } }` with no position, then `region.set` naming them — the group is placed around them where they sit, gutter included. The same holds for members added with `within` after it: a group added with no position is placed around what goes in it, wherever you put them. `within` on a node.add places that node inside a group that already exists (or was added earlier in the batch); `within: null` means no group |
| structure or intent is wrong | create a fresh document with a `document.create` op and redraw |

**A group has no member list.** What it holds is whatever lies fully inside its bounds, so a
`node.patch` of the group alone leaves its contents where they were (patch the members in the same
call, with `within: "<group id>"` in place of `id`). `node.add` with `within`, `region.set` and
`tidy` with `within` all read that same containment.

**`region.set` is the one op that deletes what you did NOT mention.** It
reconciles a group's contents to the list you give it, so anything strictly
inside that group and absent from your list is removed. Four rules make it safe
to reach for:

- Only nodes **fully enclosed** by the group are in scope. A node straddling
  its edge — someone mid-drag — is untouched.
- An **edge is in scope only when BOTH its endpoints are.** One that leaves the
  group survives your list without being mentioned.
- `nodes` (and `edges`) are lists of id **strings**, never node objects. A node
  you list that is already inside the group stays exactly where it is; one
  listed that is **elsewhere** is moved in to a free spot inside it, so a region
  edit leaves no member outside its group.
- A **locked** node or edge in scope **refuses the whole batch before anything
  is written**, because this op deletes by omission and silently skipping a
  locked element would be the worst possible reading of that.

```js
// The group "pipeline" keeps exactly these two nodes and the edge between them.
wb_canvas_edit({ workspaceId, documentId, mode: "apply", ops: [
  { op: "region.set", within: "pipeline", nodes: ["ingest", "transform"], edges: ["ingest-to-transform"] },
] })
```

To create a new member, add it with `node.add` and `within` rather than naming
it here. Use `region.set` when you own the whole group; use plain `node.patch` /
`node.remove` ops when you do not.

**A lock binds you too.** A `patch` or `remove` on a locked element fails the batch, and so does `wb_facet_set` on it (its facets and its tags, including a tag rename that would reach it). Unlocking is the
one op a locked element still accepts, so you can lift your own lock in the same call:
`[{ op: "node.lock", id: "x", locked: false }, { op: "node.patch", id: "x", patch: { x: 40 } }]`.

Pruning is cheap now, so plan placement normally rather than defensively — but prefer redrawing on a
fresh document when the STRUCTURE is wrong, not just a few elements.

After each fix, go back to Step 4 and render again.
Redrawing on a fresh document is normal whiteboard behavior when the structure is wrong, not failure.

---

## Shapes, Stencils And Tags

A box is a rectangle until a facet says otherwise. Ask `wb_facet_list({ workspaceId })` before
naming one: it answers the exact facet keys and payload schemas, the stencil / icon / theme ids a
write may name, and for that workspace its own stencils (`workspace.<name>`), the tags already in
use and its tag library.

- **A silhouette**: `facets: { "visual.shape/v0": { kind } }` on the node, `kind` one of `ellipse`,
  `diamond`, `hexagon`, `parallelogram`, `cylinder`, `octagon`. A decision is a `diamond`.
- **A stencil**: what the box IS, named once. `stencil` is a key of the op, beside `node`, not
  inside it: `{ op: "node.add", node: { id: "users", type: "text", text: "Users" }, stencil: "visual.datastore" }`.
  `node.patch` takes it too. The six bundled are `visual.datastore` (cylinder), `visual.service`
  (octagon), `visual.gateway` (hexagon), `visual.queue` (parallelogram), `visual.actor` (ellipse)
  and `visual.external` (diamond, the same silhouette as a decision, so a board with both should
  word its decisions as questions). An explicit `color` wins over the stencil's, and an id nobody
  registered is refused with the registered ones listed. A workspace can define more in its own
  library, which `wb_facet_list` shows.
- **An icon is not for the board.** `visual.symbol/v0` stands for an object on small surfaces (the
  minimap, the document browser, a tab) and is not drawn on a canvas. To mark kind or state on a
  board, use a tag.
- **A tag** records state or kind: `wb_facet_set({ workspaceId, documentIds: [documentId], nodeId, tags: { add: ["health:failing"] } })`
  (`edgeId` for an edge; neither tags the board itself). A key the workspace's tag library declares
  gives each value a colour, so the boxes wearing it are drawn in it and the board's legend names
  it; a value the library does not admit is refused, and a tag nobody declared is recorded and
  drawn in nothing. `wb_document_search({ workspaceId, tags: ["health:failing"] })` then finds the
  documents that carry it.

Pick the stencil or silhouette per ROLE once for the document and reuse it, which is how
[`../coauthoring-visuals/references/technical-role-profiles.md`](../coauthoring-visuals/references/technical-role-profiles.md)
keeps a role recognisable.

---

## Checklist When You Are Unsure

- [ ] did you write down the one question the diagram should answer before drawing?
- [ ] did you choose the diagram family from [`visual-vocabulary.md`](./visual-vocabulary.md)?
- [ ] did you draw the whole diagram in ONE `wb_canvas_edit` call rather than one call per node?
- [ ] if you set coordinates at all, did you plan a rigid grid — or let placement happen and finish with a `tidy` op?
- [ ] if you named heights, do they hold their text? (omit the height and it is sized to fit)
- [ ] did you use semantic, consistent colors even though the tool has no named color keys?
- [ ] can the main path / supporting info / problem / proposal be distinguished visually?
- [ ] are edge labels duplicating what node text already says?
- [ ] did you render with `wb_scene_render` (or read the board with `wb_canvas_snapshot`) and inspect it?
- [ ] if structure or intent needed rethinking, did you redraw on a new document instead of trying to prune the old one?

---

## Notes

- **Every applied write is a remote change.** A `mode: "apply"` call changes the document at once
  (without a mode, content is stored as a proposal for the person to adopt instead); there is no
  separate "commit" step and no local undo. One `wb_canvas_edit` call is atomic — a rejected batch
  leaves nothing behind — but a batch that SUCCEEDS is not undoable, so save a
  `wb_version_save({ workspaceId, documentIds: [documentId], label })` before a risky one and call
  `wb_version_restore({ workspaceId, documentId, versionId: saved[0].version.id })` to roll back if
  it goes wrong. `documentIds` is plural and the label is shared, so a change spanning several
  documents gets ONE checkpoint across all of them in one call. The version lands in the same history the person's History panel shows, so they can see
  the checkpoint and restore it themselves. To try an alternative without touching the original,
  restore the checkpoint into a new document with `targetPath` instead of in place.
- **whiteboard MCP is a local dev tool**: documents live under `~/.whiteboard/`, outside git. If you
  need the SVG in a PR or other artifact, save the string `wb_scene_render` returns to a file.
- **A document's format is fixed at creation.** `kind: "spatial"` gives you nodes and edges;
  `kind: "markdown"` gives you an OKF Markdown body — a `document.set` op replaces the whole
  document, `wb_body_edit` replaces individual passages of its body — and has no nodes or edges of
  its own. (A text NODE on a spatial canvas is edited with `wb_canvas_edit`'s `node.patch`
  — `text` replaces the whole body — or `node.splice` for a line range; neither can reach a
  markdown document's body, which lives in a text container the canvas read does not see.)
  There is no format parameter on read — `wb_document_get`
  answers in whichever format the document already is.
