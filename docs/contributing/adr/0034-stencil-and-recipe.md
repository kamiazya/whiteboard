# ADR-0034: Stencil and recipe — a reusable element and a reusable arrangement, as two concepts

**Status:** Proposed — the vocabulary, the boundaries, who may author one, and
the measurement plan. The stencil half lands first and is judged by the three
axes already pinned ([ADR-0031](0031-tool-surface-criteria.md) §7's drawing
score, [ADR-0032](0032-composition-axis.md)'s composition axis,
[ADR-0033](0033-facet-vocabulary-axis.md)'s facet axis) plus the eval lane's
`meanCalls`. Any rule a reading changes is rewritten here, the way ADR-0032's
three were.

## Context

ADR-0033's first reading is the starting point and it is stark: across the
whole drawing corpus — the hand-drawn references included — every board spends
ONE treatment, reads `distance 0`, and owes all 22 constructs it declares. The
appearance channel is not under-used, it is unopened, and by everyone rather
than only by the model.

The question that leaves is what to do about it, and the obvious answer is the
one this ADR exists to reject as a first move: tell the model to colour things.
That pushes the whole burden onto whoever is drawing, one node at a time, in a
vocabulary they have to invent per board. It costs ops — the eval lane's
`meanCalls` is the column that reads it — and it produces a vocabulary that is
private to one drawing, so nothing accumulates.

The user's direction (2026-09-11) is the other answer: make the reusable thing
a FIRST-CLASS OBJECT, so a few ops expand into a lot of drawing and the caller
does not need to know the details. Named explicitly: infrastructure diagrams,
where the vocabulary is large, standard, and owned by somebody else (a cloud
vendor's icon set), and where a person or a community should be able to grow
the library rather than wait for this repository to ship it.

Two things in that direction are DIFFERENT SIZES, and the first decision is to
stop treating them as one.

## Decision

### 1. Two concepts, two names, adopted before any code

| word | means | does NOT mean |
|---|---|---|
| **Stencil** | a reusable single ELEMENT: a named appearance (colour, silhouette, badge) plus a default size, applied to ONE node — "a database", "an EC2 instance" | a node; a template with slots; anything about where the node goes |
| **Recipe** | a reusable ARRANGEMENT: a named structure — the roles, the containment and the connections a shape of diagram has — expanded into many nodes and edges at once, e.g. "a three-tier web app", "a VPC with a public and a private subnet" | coordinates, a layout, or a saved canvas |

`stencil` occurs nowhere in this repository and is the diagramming domain's
own word for exactly this object (Visio and OmniGraffle stencils, the cloud
vendors' icon sets), which is the vocabulary the community this is for already
speaks. `recipe` occurs only in prose, is the user's own word for the idea, and
is deliberately less authoritative than `blueprint` or `template`: a recipe is
something you are expected to adapt.

They are kept apart because they MOVE DIFFERENT NUMBERS, which is what lets
each be adopted or refuted on its own evidence. A stencil moves the facet axis
(`deficit` down, `treatments` up) and barely touches geometry. A recipe moves
`meanCalls` and the composition axis and says nothing about appearance on its
own. One concept covering both would be judged by an average of the two, which
is the shape ADR-0032 refused for its own columns.

### 2. A recipe declares STRUCTURE. It never emits coordinates.

A recipe names roles, which role contains which, and which role connects to
which. Turning that into positions is `layoutSpatialCanvas` and `tidyNodes`,
exactly as it is for a board a person draws by hand.

This is not a preference. `package-canvas-render.md`'s standing rule is **one
producer per geometry, or a parity test**, and it is there because two
independently-grown producers of "the same" geometry have shipped real defects
in this repository twice. A recipe that carried x/y would be a second layout
engine with no instrument on it, and every improvement tidy makes would stop at
the boundary of whatever a recipe placed.

The consequence worth stating plainly: a recipe's output is tidied like
anything else, and a recipe that only looks good because it hard-coded a
pleasing arrangement is a recipe that has not been shown to be good at all.

### 3. A stencil sets APPEARANCE and size. It never sets position or content.

What a stencil may carry is exactly the three channels ADR-0033 identified as
able to say "these two differ in KIND" — `node.color`, `visual.shape/v0`,
`visual.symbol/v0` — plus a default width and height, which is a fact about how
big that kind of box needs to be to hold its label.

Nothing else. Not a position (rule 2's reason applies at this scale too), and
not text: the label is what the drawing is ABOUT, and a stencil that supplied
it would be drawing the diagram rather than supplying its vocabulary.

The narrowness is what makes the measurement legible. A stencil moves the facet
axis and can only move the drawing axis through SIZE, so a reading that finds
the drawing axis moved has found something worth explaining rather than noise.

### 4. A library is DATA, authored by users and communities — not a
distribution-time schema

This is the constraint the whole design has to fit, and ADR-0013 decision 3
already fixed the shape: facet SCHEMAS are registered at distribution time, and
there is no runtime user-defined facet, because the governance and security
blast radius of runtime extension is wider than it looks. That ADR also named
the escape valve, and it is the one used here: **runtime-variable VOCABULARY is
payload under a registered schema, not a runtime schema.**

So:

- The SCHEMA of a stencil and of a recipe is registered once, at distribution
  time, like any other facet — small, closed, and reviewed here.
- A LIBRARY of stencils or recipes is a DOCUMENT in a workspace. It syncs,
  versions, exports and shares through machinery that already exists, a
  community can publish one as a file, and a person can fork one and change a
  colour without this repository shipping anything.

The bundled sets may still ride `plugin.assets` the way ADR-0030's themes and
icon sets do — a built-in is a distribution decision. What must not happen is
that being the ONLY way in, which is what turns "the community grows it" into
"we ship it for them".

### 5. A stencil is EXPANDED into the node, and also RECORDED on it

Both, and they are different layers rather than a redundancy.

**Expanded**: applying a stencil writes the ordinary `visual.*` facets and
colour onto the node. So the drawing is self-contained — every existing reader,
export path and rasteriser draws it with no knowledge of stencils at all, and a
document that travels without its library still draws correctly.

**Recorded**: the node also carries which stencil it came from, as the payload
of a registered facet whose key the implementing increment fixes.

The record is not bookkeeping; it is what makes the measurement work. ADR-0033
DECLARED a third partition it did not compute — a referenced document's OKF
`type` — and a stencil id is the same kind of thing and computable without a
reference bundle: it is a distinction the DOCUMENT states about its own boxes.
With it, applying stencils by kind lowers `deficit`. Without it, the same
drawing would read as `excess` — an appearance whose wearers correspond to no
declared construct — and the axis would score a genuine improvement as a
defect.

A node whose facets are later edited by hand keeps the record and the record
becomes false. That is accepted: it is the ordinary cost of a denormalised
field, it is invisible to every renderer, and the alternative (re-resolving
appearance from the library at draw time) is the "document unreadable without
its library" failure the expansion above exists to avoid.

### 6. Applying one is a FIELD on the ops that already exist, not a new tool

`node.add` gains a way to name a stencil; a recipe expands through the canvas
edit surface the same way. Not because tool count is a criterion — ADR-0031
says plainly that it is not — but because a field on an op a model already
calls rides discovery it already has, while a new tool is one more thing that
has to be found before it can be used. The lane is what will say whether that
is true here.

### 7. Granularity: a stencil is one box; a recipe is a sentence

The criterion, so this does not turn into a library of everything:

- A **stencil** is worth existing when a reader of the finished drawing would
  name the box as a KIND — "that's a database" — and when more than one drawing
  would use it.
- A **recipe** is worth existing when a person would ask for it in one phrase
  and mean a specific structure by it. "A three-tier web app" qualifies. "Two
  boxes with an arrow" does not: it is not a structure anybody has a name for,
  and expanding it costs more to say than to draw.
- A recipe needing an argument per node it creates is TOO FINE. At that point
  the caller is drawing the diagram through a worse interface than the one they
  already have.

### 8. Stencils first

Smaller; directly moves the axis that was just instrumented and has a baseline
sitting under it; and it is the vocabulary a recipe needs — a recipe that
places "a database" without a stencil for one has to invent the appearance
inline, which is the per-board private vocabulary this ADR is trying to
replace.

## How it is judged

Both halves are measured by instruments that already exist, against baselines
already pinned. Stated before the work, so a reading cannot be chosen after the
fact:

| number | source | what adoption must do |
|---|---|---|
| `meanCalls` | the eval lane | DOWN **for a recipe**. NOT a stencil claim — see the correction below |
| `deficit` / `constructs` | ADR-0033 | DOWN, from the pinned 22-of-22 |
| `treatments`, `distance` | ADR-0033 | UP from 1 and 0 — the channel opens |
| `excess`, `overload` | ADR-0033 | NOT up. A vocabulary applied where the document declares nothing is decoration, and this is where a stencil most plausibly goes wrong |
| `debtFreePowK` | ADR-0031 §7 | NOT down — appearance must not be bought with defects |
| composition columns | ADR-0032 | not worse |

**Correction, from the stencil increment's own measurement (2026-09-11).**
This table first read `meanCalls` DOWN as "the burden claim, and the whole
point", for both halves. Measured, that is wrong for a stencil and the reason
is structural rather than a tuning result: `wb_canvas_edit` takes an `ops`
array, so dressing six boxes was already ONE call and cannot become fewer.
The errand scoreboard puts the same six boxes at 1253 request bytes by hand
and 916 with a stencil named — one call either way.

Worse for the argument as originally written: the `stencil` field costs
`wb_canvas_edit` 480 visible bytes on ADR-0031's rung-1 scoreboard, and those
are paid on every turn of every conversation with the server attached, while
the 337 is saved once per errand that dresses anything. **On bytes alone the
field does not pay for itself.**

So a stencil's case rests on the facet-axis rows below and on `benefit`'s
`elimination:` column — a board says what its kinds ARE instead of spending a
scheme invented per drawing, and two boards drawn a week apart say it the same
way. `meanCalls` remains the recipe's claim, where a structure that today
costs many ops in one batch could cost one op naming the structure; that half
is unmeasured and stays a hypothesis.

The general lesson is the one `measured-change` already states, and this ADR
walked into it anyway: a burden claim aimed at a stopwatch that cannot see the
burden reports a null that reads as a verdict on the change. The instrument
has to match the currency, and the currency here was never calls.

Two honest notes on what those numbers can and cannot say. None of them can
say whether the stencil chosen for a box was the RIGHT one — ADR-0033 fixed
that limit for its own columns and it is inherited here. And `excess` is the
column that has never been non-zero on any real board, so the first stencil
reading is also the first population that could make this instrument wrong;
a non-zero `excess` is to be read as a hypothesis about the drawing AND about
the column, not as a verdict.

## Amendment (2026-09-11): the two SCOPES, and what a workspace library is

Decision 4 said a library is "a DOCUMENT in a workspace" and left a fork
unstated that the implementation then walked straight into. Settled here
before the code, because getting it wrong is expensive in a stored shape.

**A plugin set is per SERVER. A library is per WORKSPACE. They are not the
same axis and one cannot carry the other.**

`deps.facetRegistry` — made real by the composition-root seam that landed
after the stencil increment — is chosen once per root, which is right for
facet SCHEMAS: ADR-0013 decision 3 fixes those at distribution time, and
nothing a user writes may define one. A library is the opposite kind of
thing: it is content, it belongs to the workspace that holds it, and it
syncs, versions, forks and travels with that workspace. So a document-backed
library does NOT ride `deps.facetRegistry`, and the increment that adds one
must not try to make it.

### What makes this safe, stated because it looks like the thing ADR-0013 forbids

A workspace library defines no SCHEMA. Every stencil in it is payload under
`stencilAssetSchema`, which is registered at distribution time like any
other, and each of its facet payloads is validated against the schema its own
plugin registered. So the blast radius is a colour string and some already-
validated facet values — not code, not a new contract, and nothing the
registry has not already agreed to accept.

That is exactly the escape valve ADR-0013 decision 3 named when it forbade
runtime facet definition: *"runtime-variable vocabulary is payload of a
facet, not a runtime schema"*. A library is the largest instance of that
valve so far, which is why the reasoning is restated here rather than cited.

### The mechanism: a synthetic plugin, not a second resolution path

A stencil is resolved through `FacetRegistry`, and a workspace library is not
a registry. The resolution is therefore to COMPOSE one — the base plugins
plus a synthetic plugin carrying the workspace's own stencils — rather than
to add a second lookup beside the first. One producer, and every reader
(`applyStencil`, the picker, `wb_facet_list`) keeps working unchanged.

Two things that follow, and neither is free:

- **A reserved namespace.** Facet ids are `{plugin}.{name}`, so the synthetic
  plugin needs an id no real plugin may take. It is `workspace`, and
  `definePlugin` must refuse it — today it is a perfectly legal id and a
  deployment could take it, which would make a collision a startup crash
  instead of a rule.
- **Caching, keyed on the library document's version.** A registry is
  immutable data built from a plugin list; composing one per tool call would
  rebuild every compat chain and asset table on every write. The
  composition-root seam already pins "built once per root" for the same
  reason; per workspace it becomes "built once per library version".

### What this costs the tool surface, named rather than discovered later

`wb_facet_list` today answers for the DEPLOYMENT and deliberately takes no
workspace id — its own doc says so. Once a library exists, "what vocabulary
do I have" has a different answer per workspace, so that tool gains an
optional `workspaceId` and the answer widens. That is a tool-surface change
and goes through ADR-0031's scoreboards like any other; it is named here so
the increment that does it expects the cost instead of discovering it.

### Not decided here

How a library is AUTHORED — a document kind, an OKF body with a facets
block, or a JSON canvas convention — and how a community distributes one.
Those need a reading of what people actually do with the first version, and
deciding them now would be inventing the fixture that justifies the change.

## Consequences

- The library being a document means a stencil is subject to the same
  permissions, sync and history as any other content, which is the answer to
  "can a tenant have its own vocabulary" without any new machinery.
- It also means a library can be BAD — inconsistent, overloaded, ugly — and
  nothing here prevents that. What the facet axis can say is whether a drawing
  using it distinguishes what its document declares; whether the vocabulary
  itself is well designed is a question none of the three axes can ask, and
  inventing a column that pretends to would be worse than the gap.
- ADR-0013 decision 8's recorded trigger — two plugins offering candidates for
  the same slot on one object — gets closer with this: a stencil carrying a
  badge and `visual.symbol` carrying one are exactly that case. Nothing is
  built for it here; it is named so the increment that hits it recognises it
  rather than inventing a precedence rule in passing.
- A recipe's output being tidied means a recipe is only as good as the layout
  under it. That is a feature — it puts recipes on the same instrument as
  everything else — and it is also a risk worth naming: a recipe that reads
  well in the abstract and tidies into a mess will look like a layout failure
  when it is a structure failure.

## Alternatives considered

**Leave it to the model: describe the channel in the tool surface and let each
drawing invent its own vocabulary.** This is the status quo, and ADR-0033
measured it: 0 of 22 constructs carried, on every board, by every drawer
including the human references. It is rejected as MEASURED-UNUSED rather than
as wrong in principle, and the distinction matters — a future surface change
could move that number, and this ADR does not claim it could not.

**One concept instead of two.** Rejected: they move different numbers (rule 1),
so folding them makes each unfalsifiable on its own evidence. This repository
has already refused an average for the same reason.

**A recipe that emits coordinates.** Rejected under the one-producer-per-
geometry rule (rule 2). The tempting version is "coordinates as a hint tidy may
override", which is worse rather than better: it is still a second producer,
and it is one whose output is silently discarded, so nobody can tell whether
the recipe or the layout drew what they are looking at.

**Register stencils as plugins at distribution time only**, like ADR-0030's
theme and icon assets. Rejected because it forbids by construction the thing
the direction asks for: a person growing their own library, and a community
publishing one. The bundled sets may still be registered that way; what is
rejected is that being the only door.

**A saved canvas as the reusable unit — "copy this board and edit it".** This
is what people do today with no tooling at all, and it is worth saying why it
is not enough: it carries coordinates (rule 2), it carries content, and it
cannot compose — two recipes in one drawing is two pasted boards, not one
structure. It is, though, the honest fallback if recipes fail to measure well,
and it costs nothing.

**Wait for a user study.** Rejected on ADR-0032's grounds: the instruments can
be honest about what they count without one, and the alternative in practice is
not a study but another session deciding by taste whether a library is good.
