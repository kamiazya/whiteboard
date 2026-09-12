# ADR-0038: OCIF is a third projection, and its decompositions discipline the native model

**Status:** Accepted — design of record (human gate, 2026-09-12). Builds on
[ADR-0037](0037-model-and-format.md), which made the model native and the
formats projections; this one adds the third projection and takes two of the
distinctions it exposes into the model. Stands on the ledger landed in
`packages/codec/src/spatial/ocif-projection.ts`.

## Context

[OCIF](https://spec.canvasprotocol.org/) — the Open Canvas Interchange Format,
v0.7.0, a Candidate Recommendation of the Open Canvas Working Group — is an
interchange format for infinite-canvas tools. Supporting it is worth deciding
on its own merits, but the reason it reached the top of the queue is a second
one: this model still carries decompositions it inherited from JSON Canvas
rather than chose, and an external standard is a way to tell the difference.

Measured before argued, the way ADR-0037 was. `OCIF_PROJECTION` is
`JSON_CANVAS_PROJECTION`'s sibling — every position the model can hold, and
what projecting it onto OCIF costs:

| | JSON Canvas 1.0 | OCIF v0.7.0 |
|---|---:|---:|
| stated by the format (`native`) | 21 | **15** |
| carried on an extension | 16 | 17 |
| crosses as something else (`degraded`) | 4 | **11** |
| cannot cross (`dropped`) | 4 | **2** |

*Correction (2026-09-12, the same day): the OCIF column above was read off the
specification, and writing the projection moved it to **native 15, extension
21, degraded 9, dropped 0**. Five rows were wrong. `nodes[].color` and
`edges[].color` are not degraded — resolving a preset needs a palette, and a
palette belongs to `canvas-render`, which depends on codec rather than the
reverse, so the colour crosses as authored on an extension of ours.
`nodes[].subpath` and `nodes[].embed.versionRef` are not dropped — what the
FORMAT cannot state and what this PROJECTION cannot carry are different
questions. And the three facet buckets were `native` in the table while the
code carried them on a vendor key, which the foreign-reader comparison caught;
they are ordinary OCIF extensions now. The original numbers are left above
because the argument below was made on them, and because a measurement taken
by reading is exactly what this correction is evidence about. **Nothing is
dropped** is the stronger form of the claim the next paragraph makes.*

**`native` falls, and that reading is the opposite of what it looks like.**
The eight positions OCIF states that JSON Canvas cannot are the ones that
matter: `x`/`y`/`width`/`height` cross **unrounded** (OCIF's coordinates are
real numbers in logical pixels, so ADR-0037 slice 4's sub-pixel geometry
survives), an embedded document crosses **natively** (OCIF nests canvases by
letting a node reference an OCIF document as a resource), and **all three
facet buckets** cross natively — because OCIF's `data[]` extension mechanism
*is* ADR-0013's facet system: a namespaced, versioned, schema'd attribute
group, declared in the file's own `schemas` array. `dropped` goes to ZERO for the
same reason — every position this model can hold reaches an OCIF document
somehow, which JSON Canvas cannot say.

`degraded` rising is OCIF **having distinctions this model lacks**:

- There is no node `type`. The spec is explicit — *"There is no special text
  node in OCIF. Text is a kind of resource."* What a node **is** comes from
  the resource it shows and the extensions it carries.
- There is no top-level `relations`. An edge is a node carrying `@ocif/edge`,
  whose `start` and `end` **must be node ids**; the spec offers `rel` so that
  `(start, rel, end)` reads as an RDF triple. An edge is a *relation*.
- A line to a bare coordinate is `@ocif/arrow` — a **shape**, with `start` and
  `end` as `[x, y]`. A drawing, not a relation.

That last pair is a distinction this codebase does not make. `CanvasEdge`
serves both, which is precisely why ADR-0037 slice 3 widened its endpoint to
`node | point` — and why that widening does not project onto an OCIF edge at
all.

## Decision

### 1. OCIF is a third PROJECTION. It does not become the native model.

ADR-0037's thesis is unchanged: the model is native, and every format is a
tested projection with a published loss table. OCIF joins JSON Canvas and OKF
under that same rule — `toOcif`/`fromOcif` in `packages/codec`, a round-trip
property over the expressible subset, and a generated loss table.

First-party support means what ADR-0037 decision 2 says it means: the
projection is tested, not that the model *is* the format.

### 2. A RELATION and a DRAWN LINE are two things.

The native model splits what `CanvasEdge` currently conflates. A relation runs
between two nodes and is what `rel`, graph traversal, and "what is connected to
what" are about. A drawn line carries coordinates, may end nowhere, and is
about ink.

ADR-0037 slice 3's free endpoint is the evidence that the conflation was
already costing something: it was reached by widening the *relation* until it
could hold a *drawing*. Slice 3b then taught the router to draw one. Both stay
— what changes is which concept owns them.

This is the distinction OCIF makes and JSON Canvas does not, which is the
whole argument for taking it: it is not our taste, it is a second designer
arriving at the same place from outside.

### 3. TEXT is a resource, not a field on a node kind.

The node-kind union (`text | file | link | group`) is inherited from JSON
Canvas and survived ADR-0037 unexamined. Under OCIF's decomposition it
dissolves: text is a resource, a file is a resource with a location, a link is
a resource whose location is a URL, and a group is `parent` plus
`@ocif/group`.

Taking this is the largest single act of distillation available, and it is
deliberately in scope: `text` on a node is where OKF, search, layout and the
markdown body all attach, so leaving it for later means every one of those
keeps being designed against a shape we have already decided is wrong.

It lands as its own increment, after the split in decision 2, and its
prerequisite is the round-trip property — a change this wide without one is
how content gets lost silently.

### 4. `OpenCanvas` stays retired, and OCIF is not it.

`.claude/rules/vocabulary.md` retires **OpenCanvas** as a working name this
project once used for its own document world. The Open Canvas Working Group's
**Open Canvas / OCIF** is a real external standard and a correct thing to name.
The vocabulary rule gains a note saying so, because the two are one search away
from each other and the guard reads prose.

## Consequences

**Easier.** A field added to the model now has to say what it costs *two*
readers, and the second one has a different shape from the first — which is
what makes the ledger informative rather than a formality. Interop stops being
a single-format claim. And the two decompositions above stop being open
questions that every later design has to route around.

**Harder.** Two ledgers drift; a fifth guard (both tables cover exactly the
same positions) exists because four directions do not catch a field entered in
one table only. Decisions 2 and 3 are model changes with wide blast radius —
the edge split reaches the router, the editor, the snapshot and the MCP tool
surface; the text change reaches OKF, search and layout.

**Unchanged.** ADR-0013's facet system, which OCIF's extension mechanism
independently validates rather than displaces. ADR-0037's ledger discipline,
which this extends rather than revises.

## Alternatives considered

**Adopt OCIF as the native model.** The largest distillation, and rejected:
it contradicts ADR-0037 directly, and it would bind the internal model to a
Candidate Recommendation that the working group is explicitly still gathering
implementation feedback on. That is the same shape as the binding ADR-0037
removed, with a different format in the slot. Taking the *decompositions*
without taking the *binding* gets the distillation and keeps the freedom.

**Wait for the ledger to tell us whether to split.** Considered and not taken
on the edge question. The measurement already answered it: the free endpoint
does not project onto an OCIF edge, and no amount of further projection work
changes that. Deferring would mean writing `toOcif` around a conflation we had
already decided was one.

**Leave the node-kind union alone.** Cheaper, and it would leave the single
largest inherited-rather-than-chosen decomposition in place while claiming the
model is native. The union is not load-bearing for anything except the code
that grew around it.
