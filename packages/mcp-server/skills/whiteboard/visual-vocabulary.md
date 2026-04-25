# Excalidraw Visual Vocabulary

What a diagram should deliver is not "a picture" but **decision support**.
This document helps choose the right diagram family and the right words so that people align faster.
For coordinates, colors, and layout rules, see [`style-reference.md`](./style-reference.md).

## Decide This First

Before drawing, answer only one question:

- **what question is this diagram answering?**
- what should the reader understand in **5 seconds**?
- is this about structure, flow, comparison, a problem, or a proposal?

Do not make one board answer multiple questions at once.

Examples that should usually be separated:
- structural explanation
- cause analysis
- improvement proposal
- before / after comparison

Default rule: **1 question per frame or canvas**.

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

## Split Across Canvases Or Frames?

Excalidraw's infinite canvas is strongest when related questions are organized **as multiple frames on one canvas**.
That does not mean every board belongs on one canvas.

Use multiple frames on one canvas when:
- you want to move between `current / problem / proposal` in one discussion
- you want side-by-side or stacked comparison
- you want section-level inspection through viewport or `export_png({ frameId })`
- you may later add cross-frame arrows or supporting notes

When using frames:
- treat the frame name as the section heading
- do not duplicate `Current`, `Problem`, or `Proposal` inside the frame
- use the first large text inside the frame for the section conclusion or claim
- even related frames should differ slightly by role
  - `current`: neutral and easy to read
  - `problem`: stronger callouts and hotspots
  - `proposal`: calmer with more whitespace

Split into separate canvases when:
- each board should be shared or exported independently
- putting everything on one canvas makes the subject unreadable within 5 seconds
- the audience or usage context differs
- revision history should stay separate

If unsure:
- for **chapters of the same discussion**, prefer 1 canvas + multiple frames
- for **separate artifacts**, prefer separate canvases

In either case, do not mix multiple questions inside one frame / canvas.

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
| what is still unresolved | note / dashed grouping / neutral box | `make uncertainty explicit` |
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
- mixing time-sequence arrows into a structural board
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

Arrow labels should usually prioritize **verbs over nouns**.

Keep arrow labels sparse:
- 1-2 labeled arrows per frame is often enough
- if the box title or callout already explains the relation, omit the arrow label
- put causes and evaluative language into the box title / subText instead of on the arrow
- keep only the minimum relationship verb on the arrow

Good split of labor:
- box: `Dense scan`
- subText: `The form lacks hierarchy, so everything competes`
- arrow label: `buries`

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
there, arrow labels may prioritize **protocol / transport over verbs**.

Good examples:
- `HTTPS`
- `gRPC`
- `SQL`
- `events`
- `JWT`

Avoid:
- long descriptive sentences as connection labels
- representing a bus only as arrow-label text

If an async path matters, give the bus / queue / topic a standalone box such as `Kafka`, `SQS`, or `EventBridge`, then split the flow into two arrows around it.

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
- show the boundary as an enclosing shell, not as the background of a box
- keep boundary labels short in the top-left
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
- screenshot annotation
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
- `Problem: primary CTA is buried`
- `Proposal: isolate CTA into top band`

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

Fix the appearance by meaning so explanation becomes lighter.

| State | Recommended Treatment |
| --- | --- |
| main path | `primary` / `success`, centered |
| supporting information | `neutral` / `info`, toward the edge |
| problem | `danger` / `warning`, local annotation |
| proposal | separate zone such as before/after or a `Proposal` frame |
| uncertainty | `neutral` and note-like treatment, kept away from settled facts |
| out of scope | faint support box or pushed outside the section |
| boundary | faint enclosure in `warning` / `info`, weaker than components |
| async path | standalone event-bus box plus supporting color distinct from the main path |

## Anti-patterns

### 1. Do Everything In One Board

Warning signs:
- a structural diagram contains both problem callouts and proposal arrows
- the reader loses track of which conversation they are in

Fix:
split into separate frames such as:
- `Current state`
- `Problem`
- `Proposal`

### 2. Arrow Labels Eat The Main Subject

Warning signs:
- the board is noisy from arrow labels alone
- callouts and arrow labels explain the same thing twice
- the viewer reads arrow words before box meaning

Fix:
- keep labeled arrows to 1-2 per frame
- move causes and intent into box title / subText
- leave only short relation verbs such as `move`, `attach`, `split` on arrows

### 3. Frame Header And Inner Title Duplicate Each Other

Warning signs:
- the frame is named `Current`, and there is also a large `Current` inside it
- the section label can be read twice before any real claim

Fix:
- let the frame name act as the section heading
- assign the large inner text to the conclusion or question
- do not repeat the same word as both frame label and inner heading

### 4. The Arrow Has No Meaning

Bad examples:
- `data`
- `sync`
- `flow`

Fix:
- write the action as a verb
- if only a noun comes to mind, the box responsibility is often still too vague

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
- red boxes and blue boxes are mixed without any explicit meaning

Fix:
- label problem areas as `Problem`
- label proposal areas as `Proposal`

### 8. Placeholders Remain

Warning signs:
- a box was removed but its empty frame still remains
- template headings or helper lines survive after losing their meaning
- an empty container sits in the section doing nothing

Fix:
- delete unused elements instead of leaving them blank
- do not force template slot count to match source-item count mechanically
- if multiple items are getting crammed into one box, add more boxes and reorganize instead

### 9. Legend Or Notes Slip Inside A Boundary

Warning signs:
- a legend sits inside an `AWS Region` or `Cluster`
- a helper note remains inside a private subnet and looks like part of the actual topology

Fix:
- keep legends / glossaries / support notes outside the boundary
- use boundaries only to show membership, not to host explanatory text

### 10. Async Paths Disappear Into Arrow Labels

Warning signs:
- `events` or `Kafka` exists only as arrow text
- the responsibility cut between services is unreadable

Fix:
- make bus / queue / topic a standalone box
- split the flow into producer -> bus -> consumer

## 5-Second Review

After export, check:

- can the main subject be read in 5 seconds?
- can the main path be traced as a single continuous reading path?
- is it obvious where the decision points are?
- can problem / proposal / uncertainty be distinguished visually?
- are labels short while still keeping relationships readable?
- is supporting information quieter than the main subject?
- does the claim survive without reading every arrow label?
- are frame names and body headings doing different jobs?
- are there any leftover placeholders or forgotten template fragments?
- are the roles of boundary and legend still separate?
- can async paths be read as independent elements?

If any of these feel shaky, re-check the framing of the question before doing cosmetic tweaks.
