# ADR-0029: A proposal is an anchored change, not a point in time

**Status:** Accepted — design of record (human gate, 2026-09-06); nothing implemented yet. Retires the variation surface [ADR-0022](0022-variation-addressing.md) addresses.

## Context

Versions and variations were built for a specific flow, stated by the project
owner on 2026-09-06: **an agent proposes changes, a person reviews them, and
the accepted ones become the document.** A pull request, in other words, and
the Git vocabulary in `packages/history` follows from that intent rather than
from imitation.

The flow was designed. What got built is the plumbing.

### What is already true, measured before designing

Three measurements, taken before any of the decisions below:

- **The proposing half was never wired.** `packages/server-core/src/tools/workspace-edit.ts`
  — the surface behind `wb_canvas_edit` — has no variation, branch, or
  proposal concept in its input. An agent can only write to the live
  document. There is no way for it to open a branch and push to it, which is
  the step the whole flow starts with.
- **The reviewing half answers in three numbers.** `planMerge` computes a
  per-element diff (`badges`, `newElementIds`, `changedElementIds`,
  `conflictElementIds`; `plan-merge.ts:39-43,178-190`). `MergeDialog.tsx:322-327`
  reduces it to `newCount` / `changedCount` / `conflictCount`, and line 38 of
  the same file records why: *"MergeResponse.previewElements available for a
  future static renderer."* The data a reviewer needs is computed and thrown
  away at the last step.
- **Merge speaks only about canvases.** Every unit `planMerge` reports is a
  spatial element. Opened on a markdown note it reports zeroes about a change
  it cannot see — which is why "give a note variations" had no honest answer
  and stayed a gap.

So the branch UI is not underused because people have not found it. Both ends
a person touches are missing, and the middle answers in the wrong units for
half the document kinds.

ADR-0022's own Context says the same thing about how the concept arrived:
*"it is what fell out of building variations on a branch API."*

### One requirement, added at design time

The same flow should serve **people working with people**, not only people
working with agents (user, 2026-09-06). That lifts the subject from "the AI's
changes" to **"someone else's work"**, and it makes a property of this product
decisive:

**The document is a CRDT, so anyone can already write to it directly.** A
branch is not a technical necessity here. It is a social one — *don't change
my document until I have looked.* The design problem is therefore a **review
surface**, not a second document.

### What a person is actually asking

| The question, at the moment it is asked | What answers it |
|---|---|
| What did they change? | review |
| Do I want it? | review |
| What did this used to be? | history |
| Can I go back? | history |

History answers the bottom two and answers them well. Variations were
answering the top two by sending a person somewhere else to look.

## Decision

Nine decisions. The first two are derived from the rest rather than asserted —
see *Why the representation is forced*, below.

### 1. A proposal is drawn on the live document, in place

Proposed changes appear on the document a person is already looking at:
a new element dashed, a changed one outlined with its previous value struck
through, a bubble offering **Adopt** and **Dismiss**. There is no second
document, no lane to switch to, and nothing to navigate away to.

The bubble uses the annotation layer's existing grammar — white card, coloured
edge, dotted leader to a pin — in a different hue. A reader who has used a
comment has already learned how to read a proposal.

### 2. A proposal is an anchored change, not a frontier

The stored unit is:

```
anchor            element id, or a passage mark
intended change   the edit itself
assumed value     what the anchor held when the proposal was made
provenance        who proposed it, and when
```

grouped into a **proposal**: the batch that arrived together.

The payload is not new. `wb_canvas_edit`'s op union is *already* an anchored
intended change; proposing is storing the op instead of applying it.

**`assumed value` does two jobs with one field.** Rendering the change needs
the previous value, to strike it through beside the new one. Detecting a
conflict needs the previous value, to compare against what the anchor holds
now. They are the same value.

### 3. An agent always proposes; a person chooses

An agent's writes are proposals by default: nobody watches an agent type, so
there is no moment at which a person could object.

People keep what they have. Two people in the same document co-edit live, as
they do today. A person proposes when they want it looked at first — an
explicit act, not a mode they are put into.

### 4. Adopting is whole-proposal by default, per-change on request

The default control adopts the proposal — *"Adopt 2 changes"*. Expanding it
gives one Adopt/Dismiss per change.

Per-change is not the default because twenty proposed changes must not become
twenty decisions. It exists because "nine of these are right and one is not"
is the common case, and without it the only reply is to dismiss everything and
ask again.

**Both halves are shipped, in that order** (project owner's decision,
2026-09-06): the whole-proposal card first, the expansion straight after.
The order was an order and not a retraction, which is what made the second
half small — the record already carried a status per change, and adopting
the whole proposal is that write applied to each open one, so the expansion
added a control over a shape that was already there.

What the editor draws: the card's default pair is named by COUNT once there
is more than one change (`Adopt 2 changes`), a disclosure beside it reveals
one verb pair per change, and the disclosure is offered only when there is
more than one — with a single change the default pair already IS the
per-change pair. Both roads call the same write with a different set of
changes, so neither can drift from the other's idea of what adopting means.

### 5. A proposal follows the document; only a real collision is flagged

When a person edits underneath a pending proposal, the proposal stays. It is
anchored to identity, not to a moment, so an edit elsewhere does not touch it.

A **conflict** is one thing and is defined precisely: the anchor's current
value differs from the proposal's `assumed value`. Those, and only those, are
marked for the person to judge.

### 6. A proposal on a markdown note is a replacement passage

The unit is a range of body text and the text intended to replace it. The
annotation layer already anchors to passages through its mark layer, with the
resolution order ADR-0026 established (mark → unique quote → quote with
context → orphaned), so a proposal rides the mechanism that exists.

This gives prose the same granularity a canvas has, and it is what makes
per-change adoption meaningful on a note.

**Where it stands.** `applyBodyChange` and `bodyChangeConflicts` (model,
beside their canvas twins) answer what adopting a passage MEANS and whether
the passage still reads what the proposal assumed. They take the resolved
range rather than resolving it: a body is a CRDT, and where a passage now
sits is answered first by the Loro mark that followed the characters, which
`model` cannot see and must not guess at — the surface has already resolved
the anchor in order to draw the proposal.

Two halves are still open, and neither is implied by the other:

- **Who produces one.** `wb_canvas_edit` is spatial-only, `wb_document_set`
  replaces a whole document, and `wb_body_patch` already spends the word
  `mode` on `full` vs `range` and targets a canvas text node. A passage
  proposal on a markdown document has no tool yet, and picking one is a
  decision rather than a detail.
- **Where a person sees and adopts one.** The proposal card is canvas chrome,
  positioned on a bubble the renderer drew; prose needs its own in-place
  surface — the annotation layer's passage highlight is the mechanism that
  exists.

### 7. `wb_canvas_edit` gains a mode, and its default is *propose*

One tool, not two: the same edit operations, with a mode saying whether they
are applied or proposed. The default is **propose**, so an agent does not
change a document directly unless it was told to.

Two tools were rejected because the same operation union would then be
declared in two places, which is the drift `zod-schema-discipline` exists to
prevent.

**The default flip was the LAST increment, and it has landed.** The mode
shipped with `apply` as its default, because a tool whose proposals no
surface shows and no verb accepts is a tool that cannot change a document at
all; the flip was gated on decision 1 (a person can see a proposal) and
decision 4 (a person can adopt one), and both are now reachable.

**What the default reads is the BATCH, not the caller** (project owner's
decision, 2026-09-06). Content — node and edge adds, patches and removes — is
proposed. A batch carrying anything else applies: `comment.*` is the
annotation layer, a lock is a claim on a document rather than a change to it,
and `tidy`/`region.set` have no anchor to follow. That is the same line this
ADR already drew when it said which verbs a proposal can carry, so the
default needs no second rule of its own.

It is not the obvious reading of "an agent always proposes", and the reason
it is the right one was found rather than argued: the MCP Apps widget submits
a person's comment through this tool with no mode, so a default that refused
what it could not propose would answer a person typing in a comment box with
an error. A mixed batch applies for the neighbouring reason — the batch is
all-or-nothing, and splitting it would be a third thing neither mode means.

`apply` is therefore what a surface a person is looking at passes
explicitly, and the product's drawing skills now do: somebody who asked for a
drawing and is waiting to see it is exactly the case decision 3 exempts when
it says a person proposes only as an explicit act.

### 8. A proposal is bounded by one request

The batch is what the agent produced in answer to one request — the unit at
which it says it is finished. Not one tool call (too fine: a single request
often makes several), and not a whole conversation (too coarse: unrelated
changes would share one Adopt).

### 9. A proposal does not expire; a pile of them collapses

Because a proposal follows the document, nothing retires it on its own. It
stays until adopted or dismissed. When several are open, the surface collapses
them to a count rather than drawing them all at once.

Time does not close a proposal, and neither does a conflict: both are reasons
to *show* it differently, and neither is a reason to decide on a person's
behalf.

## Why the representation is forced

Decisions 1 and 2 were derived, and this section is the derivation — the
project owner asked for what the shape *should* be before asking what to keep.
Two of the decisions above settle it, and they agree.

**Decision 5 (follow the document) rules out a point in time.** A frontier is
a fixed point in the oplog. When the document moves past it, the frontier does
not carry the proposal along — the proposal is stranded at a state that is no
longer anyone's. Following requires being anchored to *identity*: an element
id, a passage mark.

**Decision 4 (adopt some of it) rules out one indivisible thing.** Checking
out a frontier is all or nothing. Adopting two of three changes requires the
proposal to be a set of independently applicable units.

Both point the same way, and the annotation layer already has exactly that
shape for a different payload: keyed per document, anchored to identity,
following edits, opened and closed. A proposal is a resident of that layer,
carrying a change where a comment carries a message.

## What this means for what exists

Judged by fit with the derived shape, not by whether it is wanted:

| Today | Verdict | Why |
|---|---|---|
| Annotation layer (`threads`, marks) | **Unchanged** | Anchored, follows edits, floats above content — the derived shape itself. It gains a payload. |
| Edit ops (`wb_canvas_edit`'s union) | **Unchanged** | Already an anchored intended change. Gains `assumed value` and a mode. |
| History (version rows over a frontier) | **Unchanged** | Answers a different question. A frontier is right for *"what did this used to be"* — a past state genuinely is a point in time. |
| `planMerge`'s **output** shape | **Survives** | new / changed / conflict per element is what a review surface renders. Its input (two frontiers) is not what will be at hand. |
| Branches (tip, HEAD, create/switch/merge) | **Does not fit** | Being a point in time, it can satisfy neither decision 4 nor decision 5. |
| The variation UI (chip, `?v=`, merge dialog) | **Does not fit** | It sends a person elsewhere to look, which decision 1 rejects. |

**A frontier is not retired.** What is retired is *using a frontier to
represent a proposal*. History keeps it, on its own merits.

## Consequences

Easier:

- **The flow this was all built for becomes reachable.** An agent can propose;
  a person can see what changed; the accepted part becomes the document.
- **Prose and canvases get the same treatment.** Decision 6 removes the
  asymmetry that left `planMerge` reporting zeroes about a note, without a
  special case for either kind.
- **Human and agent collaboration are one mechanism.** Provenance differs; the
  surface does not.
- **The header loses two controls.** The variation chip and its overflow menu
  leave the document row; a proposal joins the inspector segment beside
  comments and history. Measured at 390px today: six controls run 12→378 with
  86px left for the title. This makes it four, which is a smaller problem than
  the one a narrow-width collapse was being designed to solve.

Harder, and these are real:

- **Two ways to change a document now exist**, and which one an actor gets is a
  rule (decision 3) rather than something visible in the act. The failure mode
  is a person expecting their edit to be a proposal, or the reverse.
- **A pile of open proposals is a new state to design.** Decision 9 says
  collapse to a count, which is a direction, not a finished answer for what a
  document with forty open proposals looks like.
- **`wb_canvas_edit`'s default changes.** Existing callers that expect a write
  to land will propose instead. This is a published surface on a `0.0.x`
  package with no users, so it is a break taken deliberately rather than a
  migration — but it is a break.
- **Two mechanisms for "someone else's changes" exist during the transition**,
  until the branch surface is removed.

## Alternatives considered

**Side-by-side preview, adopt the whole thing** — today's shape, tidied. It is
the smallest change and it is what the branch machinery already supports.
Rejected on decision 1: it makes a person leave the document to see what
changed, and on decision 4: a frontier cannot be partly adopted. Both costs
land on the reviewer, who is the person this flow exists for.

**A proposal as a point in the document's history, diffed against now.** It is
the tidiest unification on paper — one list, one mechanism — and it was the
shape suggested when the idea of merging History and variations first came up.
Rejected because it puts a *past state* and a *proposed future* in the same
column, which is precisely the confusion the split is meant to remove: one is
where the document has been, the other is somewhere it has not gone.

**Keep branches and add proposals beside them.** Rejected on cost to the
reader, not on implementation cost: "work in another lane" and "propose and
have it looked at" would sit side by side, and choosing between them would be
a decision at every use. The header crowding also stays.

**Rebuild the frontier mechanism too.** Considered when the question was still
"what do we discard", and dropped once the derivation was done: history's use
of a frontier is correct, and rebuilding it would put a working History,
Bookmark and Restore — including the markdown half that only just started
working — through a migration for no gain.
