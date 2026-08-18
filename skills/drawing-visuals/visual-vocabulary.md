# Visual Vocabulary

What a diagram should deliver is not "a picture" but **decision support**.
This document helps choose the right diagram family and the right words so that people align faster.
For coordinates, colors, and layout rules, see [`style-reference.md`](./style-reference.md).

## Decide This First

Before drawing, answer only one question:

- **what question is this diagram answering?**
- what should the reader understand in **5 seconds**?
- is this about structure, flow, comparison, a problem, or a proposal?

Do not make one document answer multiple questions at once.

Examples that should usually be separated:
- structural explanation
- cause analysis
- improvement proposal
- before / after comparison

Default rule: **1 question per document**.

## Choose Visual Direction Early

For persuasive, comparative, or review-oriented boards, decide not just the diagram family but also the **visual direction**.
This is not about ornate styling.
It is a short declaration of what the viewer should read first.

Decide:
- dominant color family
- the impression that should remain after 5 seconds
- text density (`whisper` / `normal` / `strong`)
- visual motif (`quiet grid`, `review markup`, `before/after contrast`, `editorial callout`, and similar)

Typical use cases:
- `current / problem / proposal`
- before / after comparison
- UI review diagrams with comments mixed in
- proposal boards that need persuasive framing

Cases where you can skip it:
- simple system flow
- purely utilitarian structure diagram
- temporary scratch note

Named themes are easier to reuse.
Examples: `systems`, `review`, `proposal`, `executive`.

## Split Across Documents Or Group Nodes?

There is no frame or membership feature on this tool surface — a document is one flat canvas of
nodes and edges, and `wb_scene_render` always renders all of it. A `group` node (label + optional
background) can loosely mark a region, but nothing tracks which other nodes are "inside" it, and
there is no way to render or export just that region.

That leaves two real choices when a discussion has multiple related questions:

- **One document, multiple visually-separated regions**: use a `group` node per region and keep
  each region's nodes physically clustered together on the grid. Cheap, but the whole SVG renders
  every time — there is no way to inspect one region in isolation.
- **Separate documents** (`wb_document_create` per question): each renders independently, can be
  shared or exported on its own, and keeps unrelated revision history apart.

Use one document with visually-separated regions when:
- you want to move between `current / problem / proposal` in one glance
- you want side-by-side or stacked comparison
- you expect to add cross-region edges or supporting notes later

Use separate documents when:
- each board should be shared or exported independently
- putting everything on one canvas makes the subject unreadable within 5 seconds
- the audience or usage context differs
- revision history should stay separate

If unsure:
- for **chapters of the same discussion**, prefer one document with visually-separated regions
- for **separate artifacts**, prefer separate documents

In either case, do not mix multiple questions inside one region.

## Choose The Diagram From The Question

| What The Reader Should Understand | Suitable Diagram | Short Intent |
| --- | --- | --- |
| what belongs where | structure / containment | `cut responsibility boundaries` |
| what flows where | flow / architecture | `make the main path visible` |
| where decisions split | decision tree / branch diagram | `show the decision points` |
| what happens first | sequence diagram | `fix the order` |
| what changed | before / after comparison | `float only the change` |
| what should be compared | comparison matrix | `align the comparison axis` |
| where the problem is | hotspot annotation | `point to the problem area` |
| what is still unresolved | note / dashed grouping / neutral node | `make uncertainty explicit` |
| what boundary something belongs to and how it connects | infrastructure / network topology | `fix boundaries and connection type` |

## Intent -> Diagram Mapping

### Show Structure

Good fits:
- layered structure
- ownership
- dependency direction

Useful words:
- `responsibility`
- `boundary`
- `ownership`
- `dependency direction`
- `input side`
- `output side`

Example labels:
- `UI Layer`
- `API Boundary`
- `Persistent Store`
- `Owned by Browser`

Avoid:
- mixing time-sequence edges into a structural board
- drawing structure and problem callouts in the same visual language

For infrastructure diagrams, decide boundary vocabulary first:
- `region`
- `cluster`
- `trust boundary`
- `public`
- `private`

Make "where it belongs" legible before "what it is called."

### Make The Reader Follow A Flow

Good fits:
- data flow
- processing flow
- request / response path

Useful words:
- `main path`
- `side path`
- `input`
- `transform`
- `output`
- `side effect`

Edge labels should usually prioritize **verbs over nouns**.

Keep edge labels sparse:
- 1-2 labeled edges per document region is often enough
- if the node text already explains the relation, omit the edge label
- keep only the minimum relationship verb on the edge

Good arrow-label examples:
- `validate`
- `persist`
- `broadcast`
- `hydrate`

Weak examples:
- `data`
- `process`
- `thing`

Infrastructure diagrams are a partial exception:
there, edge labels may prioritize **protocol / transport over verbs**.

Good examples:
- `HTTPS`
- `gRPC`
- `SQL`
- `events`
- `JWT`

Avoid:
- long descriptive sentences as connection labels
- representing a bus only as edge-label text

If an async path matters, give the bus / queue / topic a standalone node such as `Kafka`, `SQS`, or `EventBridge`, then split the flow into two edges around it.

### Show Boundaries

Good fits:
- AWS / GCP / Azure infrastructure
- VPC / subnet / DMZ
- Kubernetes clusters / namespaces
- internal vs external system integration

Useful words:
- `region`
- `cluster`
- `namespace`
- `public`
- `private`
- `dmz`
- `trust boundary`

Rules:
- show the boundary as a `group` node sized to enclose its members, not as a background fill on the components themselves
- keep boundary labels short — the `group.label` field, not a separate node
- move legends and helper notes outside boundaries
- components are the main subject; boundaries provide context

Good labels:
- `AWS Region: ap-northeast-1`
- `Kubernetes Cluster`
- `Private Subnet`
- `Trust Boundary`

### Show Decision Points

Good fits:
- branching
- feature flag logic
- exception handling

Useful words:
- `decision`
- `condition`
- `branch`
- `allow`
- `deny`
- `fallback`

Rules:
- do not stop at `Yes / No`; say what the condition means
- keep exception paths slightly away from the main path

Good labels:
- `snapshot exists?`
- `auth ok`
- `conflict detected`

### Align Comparison Axes

Good fits:
- before / after
- option A / B
- component x environment matrix

Useful words:
- `current`
- `proposal`
- `diff`
- `common`
- `change`
- `out of scope`

Rules:
- fix the axis either left/right or top/bottom
- keep comparison targets in the same order and same granularity
- use color or annotation to surface differences, but do **not** rely on color alone

### Point To A Problem Area

Good fits:
- screenshot annotation via a `file` node plus overlaid `text` nodes
- existing-screen review
- local explanation of a failure point

Useful words:
- `problem`
- `bottleneck`
- `crowding`
- `mismatch`
- `split gaze`
- `unclear intent`

Rules:
- 1 annotation = 1 problem
- do not cram both the problem and the proposal into one label

Good split:
- one node: `Problem: primary CTA is buried`
- a second node nearby: `Proposal: isolate CTA into top band`

### Make Uncertainty Explicit

Good fits:
- hypothesis-stage design
- unsettled requirements
- rough notes before comparing multiple options

Useful words:
- `hypothesis`
- `unresolved`
- `needs confirmation`
- `candidate`
- `pending`
- `out of scope`

Rules:
- push uncertain information toward neutral treatment
- do not style it like a final decision
- if you use `?`, also say what is unknown

## Recommended Label Vocabulary

Prefer compact vocabulary that still carries meaning.

### Roles

- `actor`
- `owner`
- `client`
- `gateway`
- `worker`
- `store`
- `reviewer`

### Relationships

- `depends on`
- `emits`
- `reads`
- `writes`
- `calls`
- `returns`
- `blocks`
- `unblocks`

### Connection Types

- `HTTPS`
- `gRPC`
- `SQL`
- `TCP`
- `events`
- `webhook`
- `JWT`
- `TLS`

### States

- `planned`
- `active`
- `stale`
- `blocked`
- `optional`
- `deprecated`
- `draft`

### Problem Analysis

- `bottleneck`
- `ambiguity`
- `collision`
- `duplication`
- `gap`
- `leak`
- `drift`

### Proposal Verbs

- `split`
- `merge`
- `move`
- `rename`
- `isolate`
- `simplify`
- `promote`
- `defer`

## Differentiate State Visually

Fix the appearance by meaning so explanation becomes lighter. There is no semantic color name in the
tool itself — pick your own hex-to-role mapping once (see [`style-reference.md`](./style-reference.md#colors)) and apply it consistently.

| State | Recommended Treatment |
| --- | --- |
| main path | primary / success hex, centered |
| supporting information | neutral / info hex, toward the edge |
| problem | danger / warning hex, local annotation |
| proposal | separate region such as before/after, or its own document |
| uncertainty | neutral hex and note-like treatment, kept away from settled facts |
| out of scope | faint support node or pushed outside the section |
| boundary | faint `group` node in warning / info hex, weaker than components |
| async path | standalone event-bus node plus a color distinct from the main path |

## Anti-patterns

### 1. Do Everything In One Board

Warning signs:
- a structural diagram contains both problem callouts and proposal edges
- the reader loses track of which conversation they are in

Fix:
split into separate regions or documents such as:
- `Current state`
- `Problem`
- `Proposal`

### 2. Edge Labels Eat The Main Subject

Warning signs:
- the board is noisy from edge labels alone
- callouts and edge labels explain the same thing twice
- the viewer reads edge words before node meaning

Fix:
- keep labeled edges to 1-2 per region
- move causes and intent into the node's own `text`
- leave only short relation verbs such as `move`, `attach`, `split` on edges

### 3. Section Header And Inner Node Duplicate Each Other

Warning signs:
- a `group` node is labeled `Current`, and there is also a large `text` node saying `Current` inside it
- the section label can be read twice before any real claim

Fix:
- let the `group.label` act as the section heading
- assign the large inner text node to the conclusion or question
- do not repeat the same word as both the group label and an inner node

### 4. The Edge Has No Meaning

Bad examples:
- `data`
- `sync`
- `flow`

Fix:
- write the action as a verb
- if only a noun comes to mind, the node's responsibility is often still too vague

### 5. The Comparison Axis Drifts

Warning signs:
- before has 3 items but after has 5
- order changes left to right

Fix:
- compare the same dimensions in the same order
- add only the difference as annotation

### 6. Abstraction Levels Are Mixed

Warning signs:
- `user action`, `Redis`, and `deploy job` sit in the same column as if they were peers

Fix:
- separate actor / service / storage / process into different bands

### 7. Problem And Proposal Look The Same

Warning signs:
- two colors are mixed without any explicit meaning

Fix:
- label problem areas as `Problem`
- label proposal areas as `Proposal`

### 8. Placeholders Remain

Warning signs:
- a node was patched down to near-nothing but its empty `group` boundary still remains
- template headings or helper text survive after losing their meaning

Fix:
- delete an unwanted node with a `{ op: "node.remove", id }` op rather than leaving it as dead
  placeholder text; its edges go with it
- do not force a fixed node count to match a source-item count mechanically
- if multiple items are getting crammed into one node, add more nodes and reorganize instead

### 9. Legend Or Notes Slip Inside A Boundary

Warning signs:
- a legend sits inside an `AWS Region` or `Cluster` `group` node
- a helper note remains inside a private subnet and looks like part of the actual topology

Fix:
- keep legends / glossaries / support notes visually outside the boundary's `group`
- use a `group` only to show membership by proximity, not to host explanatory text

### 10. Async Paths Disappear Into Edge Labels

Warning signs:
- `events` or `Kafka` exists only as edge text
- the responsibility cut between services is unreadable

Fix:
- make bus / queue / topic a standalone node
- split the flow into producer -> bus -> consumer

## 5-Second Review

After rendering with `wb_scene_render`, check:

- can the main subject be read in 5 seconds?
- can the main path be traced as a single continuous reading path?
- is it obvious where the decision points are?
- can problem / proposal / uncertainty be distinguished visually?
- are labels short while still keeping relationships readable?
- is supporting information quieter than the main subject?
- does the claim survive without reading every edge label?
- are section labels and inner node text doing different jobs?
- are there any leftover placeholders or forgotten template fragments?
- are the roles of boundary and legend still separate?
- can async paths be read as independent elements?

If any of these feel shaky, re-check the framing of the question before doing cosmetic tweaks.
