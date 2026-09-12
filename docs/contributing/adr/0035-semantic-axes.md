# ADR-0035: A semantic axis is declared, and a channel carries at most one

**Status:** Accepted for the instrument and the declaration, which are landed
and measured. The consequence for the bundled stencils — that they spend the
colour channel on the kind axis — is stated here as a decision and NOT yet
carried out; §5 says what it costs and what has to be true first.

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

   `visual.shape/v0` holds five silhouettes and the default rect. `service` is
   the one stencil with no silhouette, so without colour it is indistinguishable
   from an undressed box — and the instrument refuses, by design, to read the
   absence of a symbol as a symbol.

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

### 5. The bundled stencils should stop spending colour — NOT YET

Under §1 and §2 the kind axis has a channel of its own (shape) and the colour
channel should be free for a second axis. §Context's third measurement prices
the move: `deficit 0 -> 1` and `distance 2 -> 1`, because `service` has no
silhouette and the shape vocabulary holds exactly five.

**It is deliberately not done in this ADR's increment, because doing it alone
would be a pure loss.** Freeing a channel pays only once something writes to
it, and until §1 landed nothing could. Two things have to be true first:

- a second axis exists that a drawing actually declares — §1 makes it
  possible, and `visual.axes/v0` has no UI and no lane task yet;
- `service` gets a silhouette, or the set drops to five dressed kinds. A sixth
  silhouette must be a POLYGON: `NodeOutline` lives in `packages/scene`, the
  renderer/plugin contract, so a new outline kind is a contract change while a
  polygon is one entry in the shape table.

Recorded as a decision rather than a follow-up because the direction is
settled: a channel carries at most one axis, and the kind axis does not get two
while a declared axis has none.

## Consequences

- ADR-0033's columns keep their meanings; `channels` and `contested` sit beside
  them, one level down, and `deficit` and `excess` are no longer read as one
  kind of debt (§3).
- ADR-0034's stencil is unchanged in what it IS and constrained in what it may
  SPEND: it is still a named appearance applied to one node, and §5 says the
  appearance should stop including a colour once a second axis is real.
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
