# Style Reference

Read this document **before** drawing.
Its job is to keep you from hand-calculating coordinates ad hoc or redrawing the same structure from scratch.

## Reasoning Budget

**Do not:**
- second-guess the diagram topic forever; choose the first strong fit among flowchart / architecture / sequence and commit
- overthink direction; if the material is tall, go vertical; if it is wide, go horizontal
- calculate coordinates in prose; choose `row` / `col` on a rigid grid and move on
- revisit every placement after the fact; place it, continue, and repair only visible overflow later

**Do:**
- state the diagram type and actors in 1-2 sentences
- place nodes on a rigid grid
- connect edges by node id (an `edge.add` op's `fromNode`/`toNode`)

There is no coordinate math for the edge itself — `wb_scene_render` computes the drawn path from the
two node ids. Node placement is the only math you might own, and only if you choose to: geometry is
optional on a `node.add`, and omitting it hands placement to the server. Set `x`/`y`/`width`/`height`
when the layout itself carries meaning, and read the rest of this note for how.

## Rigid Grid

Use the following grid in all diagrams.
Minor deviations are not worth the cognitive cost.

| Item | Formula | Example |
| --- | --- | --- |
| column x | `col * 220 + 40` | col=0 -> 40, col=1 -> 260, col=2 -> 480 |
| row y | `row * 140 + 40` | row=0 -> 40, row=1 -> 180, row=2 -> 320 |

**Box sizes** (there is no auto-sizing, so pick generously)

| Shape | width x height |
| --- | --- |
| short label (1 line) | 160 x 60 |
| longer text (2+ lines) | 280 x 90 |
| a `group` boundary node | size it to enclose its members with margin |

Pick row and column indices, then fill in `x`, `y`, `width`, and `height` on the node object.

## Colors

The `node.add` / `node.patch` / `edge.add` / `edge.patch` ops accept `color` as either a 6-digit
hex string (`#1971c2`) or one of the JSON Canvas numbered presets `"1"`-`"6"`. There is no semantic
color name — `"primary"` is not a valid value. Pick your own hex-to-role mapping and keep it
consistent across the document:

| Suggested Role | Example Hex |
| --- | --- |
| primary / entrypoint | `#1971c2` |
| success / service | `#2f9e44` |
| danger / error path | `#e03131` |
| warning / caution | `#f59f00` |
| info / supporting | `#228be6` |
| neutral / structure | `#495057` |

Keep the same role on the same color throughout one document.
Aim for four colors or fewer.

Think in a **palette budget**:
- 60% whitespace / neutral / structure
- 30% primary role colors
- 10% warning / danger / emphasis

Hierarchy should come mostly from layout, not from painting everything in emphasis colors.

## Edges

```js
wb_canvas_edit({
  workspaceId, documentId,
  ops: [
    { op: "edge.add", edge: { id: "req", fromNode: "client", toNode: "server", label: "request", toEnd: "arrow" } },
  ],
})
```

- both `fromNode` and `toNode` must be on the canvas by the time the op runs — a node added earlier
  in the SAME `wb_canvas_edit` call counts, anything else refuses the whole batch
- `fromSide`/`toSide` (`top`/`right`/`bottom`/`left`) hint which face of the node the edge leaves from
- `fromEnd`/`toEnd` (`none`/`arrow`) control arrowheads independently on each end
- there is no dash/line-style field on an edge — a distinction like "async vs sync" has to be carried
  by color or label, not by stroke style

## Labels

- keep them short: 1-3 words is the target for a node's `text`
- use only 1-2 labeled edges per diagram section when possible
- if an edge label only restates what the connected nodes already say, drop it
- keep one language per diagram
- there is no automatic text wrapping — a node's `text` renders as given, so break long text into
  `\n`-separated lines yourself and size `width`/`height` to fit

### Width Heuristics

- for mostly Latin text, start with `max(160, charCount * 9)`
- for mostly CJK text, start with `max(160, charCount * 18)`
- for mixed text, do not estimate as if it were ASCII-only
- secure readable width before adding more nodes

## Boundary / Zone Labels

A `group` node (label + optional background) is the only built-in boundary shape. It has no
membership tracking — nothing "belongs to" a group automatically, so drawing a boundary means
sizing the group node to visually enclose the nodes you intend it to cover, and keeping them there
when you move things later.

- do not put a large boundary/zone label inside a regular `text` node meant for content
- place the boundary's own label as a short `group.label`, not repeated inside a child node
- do not omit boundary or trust-zone names if they matter to the reading path

## Direction Consistency

**Keep one dominant flow direction.**
Readers track either left-to-right or top-to-bottom.
If edges constantly run backward, attention stalls.

### Recommended Semantics For Direction

| Diagram Type | Left / Top | Center | Right / Bottom |
| --- | --- | --- | --- |
| user-driven architecture | user / client | gateway / API / auth | services / persistence |
| system integration | internal system | adapter / integration point | counterpart / external system |
| data pipeline | source | transform / aggregate | sink / BI / notification |
| deploy / release | code / build | staging | production |
| authorization flow | resource owner / user | auth server / STS | resource server / API |

If unsure, keep user-facing or front-stage elements to the left / top and backstage systems to the right / bottom.

### Automatic Layout

The `{ op: "tidy", scope? }` op re-lays-out node positions. It has no `direction`, `pins`, or
`groups` parameters — it is a single automatic pass, not a configurable layout engine. Pass `scope`
(a list of node ids) to restrict which nodes it moves; everything outside `scope` acts as a fixed
obstacle. A locked node is also treated as fixed, whether or not it is in `scope`. Whatever moved
comes back under `geometry`.

Put it last in the same call that drew the diagram rather than in a call of its own.

If you need a layout `tidy` cannot produce, place nodes by hand on the rigid grid instead.

### When Backward Flow Is Unavoidable

- use a visibly different color for response / callback edges
- or leave the return path implicit and draw only the main forward path, then explain the return in text

---

## Layout patterns

Each diagram family has a best-practice shell.
Read the relevant recipe before drawing so you know the shell, the must-have pieces, and the common traps.
All recipes below use only `text`/`link`/`file`/`group` nodes, `edge.add` ops, and manual grid
coordinates — nothing here assumes a feature the tool surface does not have.

| What You Need To Show | Recipe |
| --- | --- |
| layered structure / data flow | [Architecture / data flow diagrams](#architecture--data-flow-diagrams) |
| time-ordered message exchange | [Sequence diagrams](#sequence-diagrams) |
| decision or branching flow | [Decision trees / branching flows](#decision-trees--branching-flows) |
| filesystem or hierarchy plus annotation | [Directory trees / hierarchical diagrams](#directory-trees--hierarchical-diagrams) |
| N-axis x M-axis comparison | [Comparison matrices](#comparison-matrices) |

---

### Architecture / data flow diagrams

**Use for**: component dependencies and responsibility splits, such as Plugin -> MCP -> Hono -> Browser -> Storage

**Shell**
- vertical axis = abstraction or dependency direction
- horizontal axis = parallel components within the same layer
- keep the main flow in one band
- place external resources to the right as secondary elements

**Must-have**
- fix color by layer or role
- edge labels should be verbs or API names
- safe box size is roughly 280-360 x 90-120 for text-heavy nodes

**Watch out for**
- if 3+ edges cross repeatedly, split into a second document
- connect side elements from the same row rather than bundling everything into one choke point

---

### Sequence diagrams

**Use for**: time-ordered actor interactions such as Browser <-> Hono <-> Browser over WS

**Shell**
- put actor headers across the top as `text` nodes
- place a vertical lifeline (a tall, narrow `text` or `group` node) under each header
- draw messages as horizontal edges between lifelines
- place local notes beside the lifeline they annotate, without overlap

**Must-have**
- do not omit lifelines
- draw external triggers as separate nodes in the left margin and feed them into the sequence
- separate qualitatively different phases with a visible gap or a `group` boundary
- keep message y-spacing generous — there is no collision detection to catch a cramped layout

**Watch out for**
- 4+ actors often overcrowd edge labels; split into two documents or reduce lanes
- keep message y-spacing around 80-120px
- response direction should match actor roles

---

### Decision trees / branching flows

**Use for**: conditional logic such as workspace resolution or validation branches

**Shell**
- stack decision nodes down the center
- keep the YES path on the main column
- push the NO path consistently to one side
- place terminal outcomes at the outer edges

**Must-have**
- use a distinct color for terminal-node outcomes
- label every branch with `YES` / `NO` plus a short condition

**Watch out for**
- phrase decision nodes as questions
- if there are 3+ decisions, keep all YES branches centered and all NO branches on one side

---

### Directory trees / hierarchical diagrams

**Use for**: filesystems or hierarchies paired with concepts such as tools / APIs / responsibilities

**Shell**
- build the tree on the left, top to bottom
- indent children by a fixed 40px per level
- place annotation nodes on the right near the matching tree node
- connect annotations back to tree nodes with edges

**Must-have**
- align all nodes strictly by indent level
- show parent-child grouping with a `group` node when it helps

**Watch out for**
- leave more initial `height` than you think you need — there is no auto-expand
- ASCII branch lines are optional if spatial hierarchy already reads clearly

---

### Comparison matrices

**Use for**: feature-by-environment coverage, before/after comparison grids, option matrices

**Shell**
- lay out a grid of `text` nodes by hand: fixed `cellWidth`/`cellHeight`/`gap`, and `x = col *
  (cellWidth + gap), y = row * (cellHeight + gap)`
- assign each item its own `row` / `col` before writing the `node.add` ops
- give the header row / column a distinct `color` from body cells

**Must-have**
- keep cell widths and heights consistent
- even an empty cell should usually still get a faint placeholder node so the grid stays legible

**Watch out for**
- beyond roughly 6 x 6, the board often needs to be split into a second document
- pre-split longer cell text into `\n`-joined lines when helpful

## Anti-patterns

- hand-calculating large batches of coordinates in prose instead of following the rigid grid
- reacting to one broken render by overfitting tiny x/y tweaks instead of returning to the grid
- choosing colors arbitrarily instead of by a fixed role mapping
- cramming 15+ elements into one document when a second document would read faster
- expecting `tidy` to accept a layout direction, pin, or grouping hint it does not have

## After Drawing

1. call `wb_scene_render({ workspaceId, documentId })` and inspect the SVG for overflow / overlap / directionality
2. if you cannot see the image, read the board with `wb_canvas_snapshot` (what is on it) or
   `wb_scene_digest` (whether it is tidy) — though `wb_canvas_edit` already returned the board under
   `snapshot`
3. if refinement is needed, send `node.patch` / `edge.patch` / `node.remove` ops before considering a
   full redraw on a new document

If you are unsure, think in this order: **logical structure -> rigid grid -> color -> label -> commit**.
