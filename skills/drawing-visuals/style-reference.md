# Excalidraw Style Reference

Read this document **before** drawing.
Its job is to keep you from hand-calculating coordinates, rediscovering layout rules, or redrawing the same structure from scratch.

## Reasoning Budget

Split responsibilities like this:
- **you** declare the logical structure: what the boxes are, what connects to what, and what the labels should say
- **the tool** handles coordinate math, arrow snapping, and label collision avoidance

**Do not:**
- second-guess the diagram topic forever; choose the first strong fit among flowchart / architecture / sequence and commit
- overthink direction; if the material is tall, go vertical; if it is wide, go horizontal
- calculate coordinates in prose; choose `row` / `col` on a rigid grid and move on
- revisit every placement after the fact; place it, continue, and repair only visible overflow later
- calculate arrow endpoints manually; name-based or box-based attachment should do the work

**Do:**
- state the diagram type and actors in 1-2 sentences
- place boxes on a rigid grid
- connect arrows by names or box ids

## Rigid Grid

Use the following grid in all diagrams.
Minor deviations are not worth the cognitive cost, and it also keeps future auto-layout viable.

| Item | Formula | Example |
| --- | --- | --- |
| column x | `col * 180 + 40` | col=0 -> 40, col=1 -> 220, col=2 -> 400 |
| row y | `row * 120 + 40` | row=0 -> 40, row=1 -> 160, row=2 -> 280 |

**Box sizes**

| Shape | width x height |
| --- | --- |
| rectangle (process / component) | 140 x 60 |
| diamond (decision) | 140 x 80 |
| large box (2+ label lines or longer text) | 280 x 80 |
| document / note | 120 x 80 |

Pick row and column indices, then fill in `x`, `y`, `width`, and `height`.

## Font Family

Use Excalidraw's `fontFamily` semantically when possible.
Current families are 5/6/7/8/9.
Values 1-3 are legacy.

| Value | Font | Use |
| --- | --- | --- |
| `5` (default) | **Excalifont** | human-facing notes, annotations, section headings, motivation text |
| `6` | **Nunito** | formal headings and document-like information |
| `7` | **Lilita One** | titles and rare emphasis |
| `8` | **Comic Shanns** | system paths, identifiers, code snippets, MCP tool names |
| `9` | Liberation Sans | another sans-serif option |
| `1` | Virgil (legacy) | usually avoid; `5` is the newer default |
| `2` | Helvetica (legacy) | prefer `6` instead |
| `3` | Cascadia (legacy) | prefer `8` instead |

Rules of thumb:
- if exact character reading matters (`{slug}.loro`, `.port`, punctuation-heavy text), use `fontFamily: 8`
- prose notes can stay on default Excalifont
- when code-ish text and human notes coexist, a side-by-side layout (`left = mono path`, `right = handwritten note`) helps separate their roles

## Colors

`annotate_batch` / `annotate` accept either hex or semantic keys in `color`.

| Semantic Key | Typical Use |
| --- | --- |
| `primary` / `#1971c2` | main actor / entrypoint / user-facing element |
| `success` / `#2f9e44` | server / service / successful path |
| `danger` / `#e03131` | error path / critical warning / arrow stroke |
| `warning` / `#f59f00` | condition / caution |
| `info` / `#228be6` | supporting or meta information |
| `neutral` / `#495057` | structure, dividers, frames |

Keep the same role on the same color.
Aim for four colors or fewer in one frame.

Think in a **palette budget**:
- 60% whitespace / neutral / structure
- 30% primary role colors
- 10% warning / danger / emphasis

Do not paint everything in emphasis colors.
Hierarchy should come mostly from layout and grouping.

**Container / boundary / support boxes should be stroke-first**
- start with stroke only
- add fill only if grouping is unreadable without it
- even then, keep the fill weaker than the primary boxes

If the board must survive dark / light switching or is meant for a dark canvas, also open [`references/dark-mode-techniques.md`](./references/dark-mode-techniques.md).

## Arrows

**Correct example**

```json
{ "type": "box_with_label", "name": "client", "target": {"x": 40, "y": 40}, "width": 140, "height": 60, "text": "Client" }
{ "type": "box_with_label", "name": "server", "target": {"x": 220, "y": 40}, "width": 140, "height": 60, "text": "Server" }
{ "type": "arrow", "startBoxName": "client", "endBoxName": "server", "label": "request" }
```

Points:
- do not pass `target` / `endTarget` or hand-calculated arrow endpoints unless you truly need a manual route
- attaching by `startBoxName` / `endBoxName` or by box ids should connect box edges automatically
- label placement should be allowed to avoid collisions automatically when possible

**Avoid**
- hand-calculating endpoints like `target: {x: 260, y: 80}, endTarget: {x: 220, y: 160}`
- drawing the same box pair twice unless round-trip semantics truly need separate arrows
- labels longer than about 20 characters without shortening or line-breaking

## Line Style Semantics

- keep **one meaning per style** within a frame
- default mapping:
  - solid: primary / sync / access flow
  - dashed: async / secondary / audit / callback
  - dotted: optional / planned / future-state
- if dashed starts to mean both `async` and `retry candidate`, move one of those meanings into notes, callouts, or another frame
- do not rely on line style alone; reinforce meaning with labels when needed

## Labels

- keep them short: 1-3 words is the target
- use only 1-2 arrow labels per frame when possible
- put explanation into box title / subText / callout and keep arrows to short verbs like `persist`, `attach`, or `promote`
- if the arrow label only restates the box title, delete it
- if the frame name already acts as the section header, do not repeat `Current` / `Proposal` inside the frame
- keep one language per diagram
- if text does not fit in a box, use `text: ["line1", "line2"]`, then inspect overflow warnings from `annotate_batch` and widen / heighten the box

### Width Heuristics

- for mostly Latin text, start with `max(160, charCount * 9)`
- for mostly CJK text, start with `max(160, charCount * 18)`
- for mixed text, do not estimate as if it were ASCII-only
- secure readable width before adding more boxes

## Arrow Spacing Heuristics

- assume roughly 150-200px of clear space between labeled-arrow endpoints
- for unlabeled arrows, 100-120px can work
- if an arrow has a label, make sure there is space around the midpoint rather than only near the destination
- "short arrow + long label" is a collision magnet; shorten the label, widen the gap, or bend the route

## Boundary / Zone Labels

- do not put large boundary / zone labels directly in the rect `text`
- place them as separate short text in the top-left
- do not omit boundary, zone, or trust names if they matter to the reading path

## Direction Consistency

**Keep one dominant flow direction.**
Readers track either left-to-right or top-to-bottom.
If arrows constantly run backward, attention stalls.

### Recommended Semantics For Direction

| Diagram Type | Left / Top (rank 0) | Center | Right / Bottom (max rank) |
| --- | --- | --- | --- |
| user-driven architecture | user / client | gateway / API / auth | services / persistence |
| system integration | internal system | adapter / integration point | counterpart / external system |
| data pipeline | source | transform / aggregate | sink / BI / notification |
| deploy / release | code / build | staging | production |
| authorization flow | resource owner / user | auth server / STS | resource server / API |

If unsure, keep user-facing or front-stage elements to the left / top and backstage systems to the right / bottom.

### Use Pins With `canvas_auto_layout`

In larger diagrams, the natural BFS ordering is not always what you want.
When that happens, use pins:

```json
canvas_auto_layout({
  canvasId: "sid/slug",
  direction: "LR",
  pins: [
    { id: "user-rect-id", anchor: "left" },
    { id: "gateway-rect-id", anchor: "center" },
    { id: "partner-rect-id", anchor: "right" }
  ]
})
```

- `anchor`: `"left"` / `"top"` -> rank 0, `"right"` / `"bottom"` -> max rank, `"center"` -> middle
- `rank`: explicit numeric rank; overrides anchor
- `column`: ordering within the same rank; `0` means leftmost
- pinned ranks should stay stable rather than being rewritten by BFS

### Parallel Structures With `groups`

`canvas_auto_layout` is fundamentally rank-based.
If you need two or more parallel columns, such as "Orders" and "Payments", separate subgraphs with `groups`:

```json
canvas_auto_layout({
  canvasId: "sid/slug",
  direction: "TB",
  groups: [
    { id: "orders", elementIds: ["oa-id", "os-id", "odb-id"] },
    { id: "payments", elementIds: ["pa-id", "ps-id", "pdb-id"] }
  ],
  groupGap: 80
})
```

- each group is ranked independently
- group-to-group edges should not dominate rank assignment
- elements outside groups fall into an implicit leading group

Use:

| Situation | Tool |
| --- | --- |
| one chain / tree | default BFS |
| semantic left / right anchors | pins |
| order within a rank | pins with `column` |
| 2+ independent chains | groups |
| full manual control | skip auto-layout and place directly |

### When Backward Flow Is Unavoidable

- use a visibly different style for response / callback paths
- or leave the return path implicit and draw only the main forward path, then explain the return in text

---

## Library-First

In icon-driven domains such as AWS / GCP / K8s / UML / network, **use a library before drawing your own symbols**.

**Search and import flow**

```js
user_library_list()
library_catalog_list({ query: "aws serverless" })
user_library_save({
  name: "aws-serverless",
  fromUrl: "<catalog item.url>"
})
library_list_items({ userLibraryName: "aws-serverless" })
library_insert_item({
  userLibraryName: "aws-serverless",
  itemIndex: 3,
  canvasId,
  target: { x, y }
})
```

**When to search**
- cloud-specific architecture
- network topology
- UML
- any diagram that depends on domain symbols

**When not to bother**
- generic rectangle-and-arrow flows
- comparison matrices
- before/after diffs
- screenshot annotation

Even confirming that no suitable icon exists is useful.

**After insertion**
- inserted items become ordinary element groups; align them with `move_elements`
- replace library text with your own terminology through `update_element` when that improves clarity
- when connecting icons, manual routing may still be needed because arrow snap behavior depends on the inserted item structure
- always inspect both icon identity and visual scale
- store "default too large / too small" knowledge in `user_library_metadata_set(... scales ...)` plus `notes`
- inserts via `userLibraryName` should auto-apply stored `scales[itemIndex]`
- `libraryUrl` / `libraryPath` have no metadata, so specify `scale` directly there

**When item names are unclear**
- treat it as a trial-insert case
- arrange 4-8 candidate indices on a scratch canvas
- inspect via `viewport_set` and `export_png`
- only place confirmed items into production

## Layout patterns

Each diagram family has a best-practice shell.
Read the relevant recipe before drawing so you know the shell, the must-have pieces, and the common traps.

| What You Need To Show | Recipe |
| --- | --- |
| layered structure / data flow | [Architecture / data flow diagrams](#architecture--data-flow-diagrams) |
| time-ordered message exchange | [Sequence diagrams](#sequence-diagrams-uml-style) |
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
- use `box_with_label` plus attached arrows

**Must-have**
- fix color by layer or role with semantic keys
- arrow labels should be verbs or API names
- safe box size is roughly 360-440 x 100-120 for text-heavy units

**Watch out for**
- if 3+ arrows cross repeatedly, split the board
- connect side elements from the same row rather than bundling everything into one choke point

---

### Sequence diagrams (UML-style)

**Use for**: time-ordered actor interactions such as Browser <-> Hono <-> Browser over WS / export paths

**Shell**
- put actor headers across the top
- place a vertical lifeline under each header
- draw messages horizontally between lifelines
- show processing windows with activation boxes
- place local notes beside activations without overlap

**Must-have**
- do not omit lifelines
- draw external triggers as separate boxes in the left margin and feed them into the sequence
- separate qualitatively different phases with visible horizontal separators
- keep local action text outside activation x-ranges so it does not get painted over
- multiline `text` sizing should be verified visually even when the tool auto-sizes it

**Watch out for**
- 4+ actors often overcrowd arrow labels; split or reduce lanes
- keep message y-spacing around 80-120px
- response / broadcast direction should match actor roles
- avoid collisions between external-trigger boxes and arrow labels
- arrow labels around activations often need to be pushed above / below to stay readable

---

### Decision trees / branching flows

**Use for**: conditional logic such as workspace resolution or validation branches

**Shell**
- stack decision nodes down the center
- keep the YES path on the main column
- push the NO path consistently to one side
- place terminal outcomes at the outer edges

**Must-have**
- use terminal-node color to distinguish outcomes
- label every branch with `YES` / `NO` plus a short condition

**Watch out for**
- phrase decision nodes as questions
- if there are 3+ decisions, keep all YES branches centered and all NO branches on one side
- do not turn the decision tree into a looping flowchart unless looping is the actual point

---

### Directory trees / hierarchical diagrams

**Use for**: filesystems or hierarchies paired with concepts such as tools / APIs / responsibilities

**Shell**
- build the tree on the left, top to bottom
- indent children by a fixed 40px per level
- place annotation boxes on the right near the matching node
- connect annotations back to tree nodes with arrows

**Must-have**
- align all nodes strictly by indent level
- show parent-child grouping with transparent container rects when needed
- use monospace for exact system paths and handwritten/default font for human-oriented notes

**Watch out for**
- auto-fit can expand height and cause downstream collisions; leave more initial height than you think you need
- ASCII branch lines are optional if spatial hierarchy already reads clearly
- if there are many annotations, align tool groups with consistent semantic color

---

### Comparison matrices

**Use for**: feature-by-environment coverage, before/after comparison grids, option matrices

**Shell**
- use `annotate_batch` with `layout: { cols, rows, cellW, cellH, gap, origin }`
- assign each item by `row` / `col`
- use `box_with_label` in each cell
- highlight header row / column differently from body cells

**Must-have**
- keep cell widths and heights consistent
- even empty cells should usually still have a faint box so the grid remains legible

**Watch out for**
- beyond roughly 6 x 6, the board often needs to be split or simplified
- pre-split longer cell text with `string[]` when helpful

## Anti-patterns

- hand-calculating large batches of coordinates in prose
- reacting to one broken image by overfitting tiny x/y tweaks instead of returning to the rigid grid
- choosing colors arbitrarily instead of semantically
- cramming 15+ elements into one frame when a split would read faster
- specifying arrow `target` / `endTarget` manually when attachment by box name or box id is sufficient

## After Drawing

1. use `export_png` and inspect overflow / overlap / directionality
2. use `canvas_inspect` to verify element counts and types
3. if refinement is needed, use `update_element` / `move_elements` / `delete_element` locally before considering full rebuild

If you are unsure, think in this order: **logical structure -> rigid grid -> color -> label -> commit**.
