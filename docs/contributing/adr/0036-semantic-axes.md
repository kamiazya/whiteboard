# ADR-0036: A semantic axis is declared, and a channel carries at most one

**Status:** Accepted, and carried out. The instrument and the declaration
landed first; the consequence for the bundled stencils — §5 — landed after the
sixth silhouette made it free, and §5 records what it actually cost against
what it was predicted to cost.

## Context

[ADR-0033](0033-facet-vocabulary-axis.md) asks whether the distinctions a
reader can SEE match the ones the document DECLARES, and its columns answer in
aggregate: `deficit` for a construct drawn with the default, `excess` for a
treatment corresponding to no construct.

Round 13 of the eval lane (2026-09-12) put a case in front of those columns
they could not resolve. Asked for a flowchart, a model painted a yellow step,
a cyan decision and a green terminal — a drawing a person reads correctly —
and declared no partition, so the board scored `constructs 0, excess 3`.

Two different readings of that were both defensible, and the user settled it
(2026-09-12): **one of this product's goals is that meaning is shared with a
model reading the document back.** So a treatment carrying a distinction the
document does not state is a real defect and not a matter of taste — a person
recovers "cyan means decision" from the picture, and a model reading the
document cannot. `excess` stays as scored.

That decision exposed the real gap, which is not about flowcharts. The user
named it (2026-09-12): an infrastructure diagram uses colour for normal-versus-
failing while shape says what each component is. **Several semantic axes on one
canvas**, each needing to be uniform within itself — and the instrument had no
notion of an axis at all, so the second one had nowhere to live.

Three measurements frame what follows. All are on `packages/canvas-render`'s
facet score; none required a model call.

1. **Every bundled stencil spends colour.** All six write a `color` as well as
   a silhouette. Dressing a board therefore consumes the channel a status axis
   would want, and nothing said so.
2. **Colour is where the muddle lands.** On the model-drawn flowchart, 2 of 3
   trials leave the colour channel spent-and-unexplained while the shape
   channel is free in all three.
3. **The sixth kind is what colour is buying.** A board wearing all six
   stencils, scored with and without their colours:

   | | colour | shape | constructs | deficit | distance |
   |---|---|---|---|---|---|
   | with colour (today) | carried | carried | 6 | 0 | 2 |
   | colour stripped | **unused** | carried | 6 | **1** | 1 |
   | five shaped stencils, colour stripped | **unused** | carried | 5 | **0** | 1 |

   `visual.shape/v0` held five silhouettes and the default rect. `service` was
   the one stencil with no silhouette, so without colour it was indistinguishable
   from an undressed box — and the instrument refuses, by design, to read the
   absence of a symbol as a symbol. §5 records what happened once a sixth
   silhouette existed and that row stopped being the price.

## Decision

### 1. An axis is DECLARED by the document, never inferred from a facet

`visual.axes/v0` is a canvas facet holding the facet keys that canvas treats as
semantic axes. Each becomes a partition beside the three the score already knew
by name (which frame holds a box, the node's kind, the stencil it wears).

Measured on one board carried through both readings — same boxes, same colours,
the only difference being whether the canvas says what the colour means:

| | `channels.colour` | `contested` |
|---|---|---|
| declared | **carried** | 0 |
| undeclared | contested | 1 |

**A list of keys rather than "every facet is an axis", and that is the whole
design.** `visual.shape/v0` is a facet and is emphatically not an axis: it says
what a box DRAWS, not what it IS. Nothing about a facet's shape reveals which
kind it is — only the document knows, so the document says. Inferring would
make every silhouette its own declared class and turn a real improvement into
a defect, which is the mistake ADR-0033 already had to unwind once for badges.

Canvas target only. An axis is a statement about the whole drawing; the same
sentence attached to one node says nothing a reader could act on.

### 2. A channel is read per-channel, not per-treatment

Each visual channel reads `carried` (constant within every class of some
declared partition, so a reader can invert it), `contested` (spent, and
explained by no declared partition) or `unused` (one value everywhere, which
is a free channel and not a fault).

`excess` counts whole `colour|shape` pairs and so cannot say which half is
unexplained — a board where shape carries the kind cleanly and colour is spent
on nothing scores the same as one where both are muddled, and those two want
opposite repairs. The per-channel reading is what makes "colour will mean
status, so kind moves to shape" a decision somebody can take.

### 3. `deficit` and `excess` are not the same kind of debt

Under §Context's criterion they fall on different axes, and the difference
decides priority:

| column | state | under "meaning shared with a model" |
|---|---|---|
| `excess` | seen, not stated | **meaning is lost — a defect** |
| `deficit` | stated, not seen | a readability cost; the meaning is intact |

A layered architecture board whose three frames are labelled and whose boxes
are identical scores `deficit 3` — and a model reading it knows the three
groups perfectly well. That is worth fixing for human readers and it is not
the same emergency as `excess`.

### 4. A silhouette vocabulary is one list

The set of silhouettes was written out four times — the facet enum, the
renderer's shape table, and hand-written arrays in a test and a bench — with
nothing tying them together. Measured by adding a sixth kind to the enum:
before, 1486 tests passed and nothing failed; a document could declare a
silhouette the renderer cannot draw and no one would be told. The enum is now
the single source, the table is checked against it both ways, and the two
copies derive from it.

### 5. The bundled stencils spend silhouette and nothing else

Under §1 and §2 the kind axis has a channel of its own, so colour belongs to
whatever second axis the drawing declares. Every bundled stencil therefore
drops its `color`, and `service` — the one member with no silhouette — takes
the sixth one.

**The order mattered and is the whole lesson of this section.** Written first,
this said NOT YET, and priced the move at `deficit 0 -> 1, distance 2 -> 1`
against a five-silhouette vocabulary. The sixth silhouette (an OCTAGON — a
`NodeOutline` kind would be a `packages/scene` contract change, a polygon is
one table entry) landed as its own increment, and one of the two predicted
costs then did not happen at all:

| six dressed boxes | `channels.colour` | `channels.shape` | constructs | deficit | distance |
|---|---|---|---|---|---|
| before (colour + silhouette) | carried | carried | 6 | 0 | 2 |
| predicted, five silhouettes | unused | carried | 6 | **1** | 1 |
| **after (six silhouettes, no colour)** | **unused** | carried | 6 | **0** | 1 |

`distance 2 -> 1` is the whole cost, and it is the thing being deliberately
given up: `distance` counts how many channels two treatments differ on, and
this change spends one channel instead of two on purpose. What the old
two-channel rule was hedging — colour lost to a projector, a colour-blind
reader, a greyscale print — is not weakened by spending no colour; that reader
was already reading silhouettes alone.

**The payoff is behaviour, not a column.** A finished board coloured by status
scores the same either way, because an author who hand-colours simply
overwrites the stencil's colour. What changed is that `applyStencil` no longer
destroys that colour: a box coloured by health, then dressed by kind, then
RE-dressed, keeps what the colour said. Before, each dressing wrote the
stencil's colour over it and the status axis was silently undrawn.

Growth is bounded the same way and by a different number. Every silhouette
distinct, and none of them the plain rect an undressed box already draws, puts
the set at the ceiling of the silhouette vocabulary: six. A seventh stencil
needs a seventh silhouette, not a seventh entry.

### 6. The second axis gets a WORD: `semantic.class/v0` (2026-09-16)

*Superseded the same day by [ADR-0040](0040-scoped-tags.md) (proposed): the
owner rejected a screen vocabulary that differs from the tools', and the
second axis becomes a SCOPED TAG (`health:failing`) on documents, boards and
nodes rather than a facet of its own. `semantic.class/v0` retires unshipped
with that ADR's increments. The reading below stands as the measurement that
led there.*

§5 freed the colour channel for a status axis and never said what fills it.
The lane measured the gap over three rounds (ADR-0031's nineteenth to
twenty-first readings): asked to tell kind and health apart at once, nine
trials of nine dressed the KIND with a stencil, coloured the HEALTH, and
wrote a node facet for it **zero** times — 30 `color` writes, 0 facets, 0
`wb_facet_set` calls, 0 declarations. Four remedies that told the model about
`visual.axes/v0` all read 0 of 3, and the raw inputs say why none could
work: every bundled facet was `visual.*` (how a box is DRAWN, not what it
IS), so there was no registered word for "health", and `node.add` took no
`facets` at all. The first axis was one word inline; the second was an
invented key, one `wb_facet_set` per box, and a canvas declaration.

**Decided (user, 2026-09-16), the first of four options:** one bundled
generic facet, `semantic.class/v0` with payload `{axis, value}` — both
lowercase identifiers — so "health/failing", "priority/high" and
"phase/design" are PAYLOAD under one registered schema. That is
[ADR-0013](0013-facet-system.md)'s escape valve applied a second time, the
road [ADR-0034](0034-stencil-and-recipe.md) §4 took for stencils. Not taken:
a workspace axis-library document (symmetric with ADR-0034 §4, heavier than
the evidence while the stencil library is at increment 1); formalising
invention (a hint, the refuted shape); a domain facet per axis (the schema
proliferation ADR-0013 avoided). It lives in a second ORDINARY bundled
plugin, `semantic`, because §1's line is what a facet SAYS and this one says
what a box is; the plugin sits in `plugin-visual` for now, its own package
when it grows a second facet or an editor.

**It is a partition the score knows by name, with no declaration.** §1
refused "every facet is an axis" because `visual.shape/v0` says how a box
draws. This facet says what a box is, which is the same reason `stencil` is
built in, so it joins `frame`, `kind` and `stencil` — and a canvas that
ALSO lists it in `visual.axes/v0` names it once, not twice. The one place to
overrule this is `declaredPartitions` in `facet-score.ts`.

**It had an inline write path for one reading, and the reading withdrew
it.** `facets` beside `op` on `node.add` and `node.patch`, validated exactly
as `wb_facet_set` validates, was built and priced the way `stencil` was: a
generic record at +600 visible / undescribed +0 against a dedicated field at
+750 / +4, the record chosen, the same field inside the draft at +1,020; it
landed at +590 visible. That is C1 up, so the rule was written BEFORE the
run: if round 18 read 0 of 3 with the field unused, the FIELD withdraws and
the facet and the partition stay, since they cost nothing a model reads
every turn. Round 18 read exactly that — 0 of 3, fifty-five node ops, the
field written zero times, `wb_facet_set` called zero times, while every
trial had called `wb_facet_list` and had the new word in its answer
(ADR-0031's twenty-second reading). The field is withdrawn in the same PR
that landed it; its shape is in that PR's history if a later reading earns
it back. What survives of the pricing is a rule about PLACE, in the
`mcp-tool-surface` skill.

**What the reading says about the axis, not the field.** Five remedies on
this task — four on what the model reads, one on what it writes — and one
reading. The model tells the two things apart the way the prompt asks, kind
by silhouette and health by colour, and does not record what the colour
MEANS because nothing asks it to; a registered word and a one-op path did
not change that. So the facet's worth is not "a model will volunteer it".
It is that a board which DOES carry it — written by a person, a skill that
says to, or a model told to — reads `carried(semantic.class/v0)` with no
declaration, and the instrument can then tell a colour that means something
from one that does not. That is the positive control in `tasks.test.ts`,
and it is the whole of what §6 now claims. The person's path came free:
the web editor's Facets panel derives a form for every registered node
facet, so it now shows a Meaning section with Axis, Value and the panel's
one Save — the first bundled facet with free entry, which is why the
browser test that pinned "no Save on this panel" had to learn its name.

Two ceilings, named so they are upgrades and not surprises: one
classification per box (a board needing "health" AND "priority" wants a
record payload and an instrument that reads a path inside it), and the
plugin's home.

## Consequences

- ADR-0033's columns keep their meanings; `channels` and `contested` sit beside
  them, one level down, and `deficit` and `excess` are no longer read as one
  kind of debt (§3).
- ADR-0034's stencil is unchanged in what it IS and constrained in what it may
  SPEND: it is still a named appearance applied to one node, and §5 says the
  appearance should stop including a colour once a second axis is real.
- **The second axis has a registered word (§6), and no inline write path.**
  `semantic.class/v0` is the first non-`visual` bundled facet and the first
  built-in partition beside `stencil`. The one-op path was landed, read at
  0 of 3 with the field unused, and withdrawn; the facet is written through
  `wb_facet_set` like any other, and read by the score without a
  declaration.
- **`channels.X` now says WHICH axis carries it** — CLOSED, in its own
  increment as this bullet said it would be. It read `carried` for both a
  board that declares a status axis and lets a stencil's colour win and one
  where colour carries status; identical columns, opposite repairs, and
  exactly the user's case. Each channel is now a reading — `use` plus
  `carriedBy`, the NAMES of the declared distinctions it is constant within
  (`frame`, `kind`, `stencil`, or a declared axis's facet key). A LIST, not
  one name: a channel can genuinely be constant within more than one declared
  distinction, and picking one arbitrarily would be the same over-claiming
  the field exists to end. `use === 'carried'` exactly when `carriedBy` is
  non-empty, held together by a test because the failure mode is a branch
  that sets one and forgets the other.

  Doing it inside §5's increment would have confounded that increment's
  reading, which is why it waited — and waiting cost nothing, because §5's
  own table reports `deficit` and `distance`, neither of which this touches.
- A canvas may name an axis carried by a facet a later build registers or this
  deployment disabled. The keys are not checked against the registry: losing a
  whole declaration to one stray key would cost more than the stray key does,
  and a key no box carries contributes no partition.
- Zero tool-table bytes. Facets reach `wb_facet_set` as a generic record, so
  the new key appears only in `wb_facet_list`'s answer, which is wire rather
  than what a model reads every turn.
- No UI writes `visual.axes/v0`. It is written through `wb_facet_set` today,
  which is what a model reaches for; a control waits until there is a second
  axis worth picking from a list, since a derived form over a free list of
  facet keys is a text box writing a key nobody can verify.

## Alternatives considered

**Narrow `excess` so a board declaring nothing is not counted.** This would
make the instrument agree with a human reader's eye — the flowchart in
§Context is a good drawing — and disagree with the stated goal. Rejected by
the user's criterion: the colour carried a meaning the document did not
record, and that is the loss being measured.

**Infer axes: treat any facet that partitions the boxes as a construct.**
Rejected in §1. It cannot tell a facet that says what a box IS from one that
says what it DRAWS, and the second is the larger population.

**Put the vocabulary at the workspace.** Rejected by the user (2026-09-12):
a workspace holds many kinds of drawing, and a single canvas can carry several
semantic axes at once, so workspace granularity is both too coarse and in the
wrong dimension.

**Add flowchart and state-diagram kinds to the bundled stencil set.** This was
proposed and withdrawn in the same session. It is not wrong — the bundled six
are all architecture vocabulary, which is why a flowchart's decision had
nowhere to land — but it treats a coverage symptom while leaving the channel
conflict untouched, and the conflict is what the user's case is about. The
coverage question stands on its own and is unresolved.

**A sentence in the tool surface pointing a model at `stencil` instead of a
bare colour.** Tried and withdrawn on its own reading (ADR-0031's thirteenth):
+133 visible bytes, mean calls up, and no facet column moved. It was read and
ACTED on — 2 of 3 trials called `wb_facet_list` where none had before — and
landed on `visual.shape/v0`, because for a flowchart there was nothing else to
land on. Recorded here because it is evidence about the TABLE rather than
about prose: the model was willing to record meaning and the vocabulary had
none to offer.
