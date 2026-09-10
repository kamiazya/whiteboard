# ADR-0033: A facet-vocabulary axis — whether what a reader can SEE matches what the document DECLARES

**Status:** Proposed — the criteria, the column definitions and the validity
claim. Sits beside [ADR-0031](0031-tool-surface-criteria.md) §7's drawing
score and [ADR-0032](0032-composition-axis.md)'s composition axis rather than
extending either. The score and its scoreboard land next, and any column
definition the calibration changes is rewritten here, the way ADR-0032's
three were.

## Context

Two axes already read a board. The drawing score judges DEFECTS and their
price; the composition axis judges what the composition hands a reader. Both
read GEOMETRY — where the boxes sit and how the lines run. Neither can see
the other half of what a drawing says.

A drawing distinguishes things in two ways. It can put them in different
PLACES, which both existing axes read. Or it can give them a different
APPEARANCE — a colour, a silhouette, a badge — which says two things differ
in KIND rather than in position, and which nothing here measures at all.

ADR-0032 named this gap in its own words and reserved C4 (`contrast`) as the
seam: `treatments` counts the visual treatments a scene ends up with,
`roles` the structural roles its graph has, and the pair is REPORTED-ONLY
because it is the geometry-side shadow of a question it cannot ask
directly. The user's direction (2026-09-10) is that question: whether the
FACET vocabulary is being used well, not only the geometry.

**The measurement that makes this urgent was taken before the ADR was
written.** The whole drawing corpus — every reference, every draft, every
tidied board, and the boards the LLM-driven lane actually produced — spends
NOTHING on this channel: zero occurrences of a colour or a facet across the
file. The lane asks a model to colour boxes in one errand task, on
instruction; no drawing task measures whether it reaches for the channel on
its own, and the corpus says it does not. So the first reading of this axis
is already predictable in direction, which is not a reason to skip taking it
— an unspent channel is a finding, and the number is what makes it
actionable rather than an impression.

## Decision

Add a **third axis**, scored beside the other two and never mixed into
either: whether the distinctions a reader can SEE line up with the
distinctions the document DECLARES.

### What the document can declare, and what can carry it

Both halves are small, closed and worth naming, because the columns below
are meaningless without them.

**The channels that can say "these differ in kind"** are exactly three, all
per-node: `node.color` (JSON Canvas), `visual.shape/v0` (the silhouette —
ellipse, diamond, hexagon, parallelogram, cylinder; absent means rect) and
`visual.symbol/v0` (a badge: a named icon or one grapheme). A node's
TREATMENT is that triple.

Three of `visual`'s facets are deliberately NOT in it. `visual.text/v0` is
placement rather than kind. `visual.theme/v0` and `visual.edges/v0` are
canvas-wide, so they cannot distinguish one node from another by
construction — a board where every node is drawn the same way has spent
nothing on distinction however striking that way is.

**A declared distinction is a PARTITION of the board's boxes that the
document itself states**, from three sources: a frame's membership (a frame
says "these belong together, as a set"), a node's kind (`text` / `file` /
`link`), and, where a file node resolves, the referenced document's OKF
`type`. A class of such a partition is a CONSTRUCT.

The `type` partition is DECLARED here and **not computed by the first
implementation**: a file node's referenced document is resolved through the
reference bundle a composition root supplies, which the scorer does not
receive. It is named because leaving it out of the definition would make the
definition wrong; the score's own doc says plainly that it reads two
partitions, not three.

What is deliberately excluded, with the reason, because a later reader will
propose both:

- **Structural role from the edge graph** (source, sink, hub) is INFERRED,
  not declared. ADR-0032's `contrast` already reads it and is reported-only
  partly for that reason. A drawing that gives its hubs no badge has not
  contradicted anything the document says.
- **OKF `tags`** are multi-valued, so they are not a partition, and forcing
  them into one is a modelling decision this ADR has no evidence for. Named
  as an omission rather than left out silently; a later version that finds
  a principled reading may add it.

### The columns, and what backs them

The frame is Moody's *The Physics of Notations* (IEEE TSE, 2009), whose
SEMIOTIC CLARITY decomposes the symbol-to-construct mapping into exactly the
four ways it can be wrong. That is the literature this question already has,
and it decomposes into computable counts rather than into taste.

**V1 — DEFICIT: a construct nothing visible carries.** A class of a declared
partition whose nodes all wear the default treatment, so the drawing says
nothing about a distinction the document states. This is the column the
corpus reading above predicts will dominate.

**V2 — OVERLOAD: one treatment carrying two constructs.** The same colour,
silhouette or badge worn by two WHOLE classes and nothing else — the
ambiguity case. A reader who has learnt that the blue boxes are one thing is
then wrong about half of them.

**V3 — EXCESS: a treatment that matches no construct.** An appearance whose
wearers CUT a class rather than covering it: three of a frame's five boxes,
say. Decoration reads as meaning whether or not it was meant to, so a
treatment lining up with nothing is a distinction the reader looks for and
does not find.

**The three cases are exclusive, and that was decided by the calibration
rather than designed.** The first implementation tested overload and excess
independently — spans two classes, and is not inside one — and every
overloaded board was charged both, because spanning two classes also fails
the containment test. So they are a partition of the cases now: worn inside
one class carries that construct; worn by whole classes carries several
(overload); worn across a class boundary carries none (excess). That is what
Moody's two terms mean, and testing them independently was the bug.

**V4 — DISCRIMINABILITY: how far apart the treatments in use are.** Moody's
visual distance: the number of visual variables two symbols differ on, and
by how much. With three channels the count is 0-3, and 0 IS overload, which
is the check that these two columns agree. Beside it, the redundant-encoding
literature is specific and worth encoding: colour and shape together measure
BETTER than either alone, most clearly at 5-8 categories, and the two
interact so a pairing is not free (CatPAW, CHI 2026; the icon colour/shape/
size studies before it). So a board using two channels for one distinction
is not double-counted as extravagance — redundancy is Moody's fourth case
and is REPORTED, never owed.

**Reported-only, never cited: `economy`** (how many distinct treatments a
board spends) and `redundancy` (constructs drawn with more than one
treatment). Both are real Moody criteria and neither has a defensible
target here: graphic economy's threshold is a claim about working memory
this project has not measured on its own drawings, and redundancy is a
virtue or a cost depending on the task.

### The validity claim, stated so it cannot be over-read

This axis measures **whether the drawing's visible distinctions line up with
the ones its document declares**. It does NOT measure:

- whether a reader understood the drawing;
- whether the distinction the author chose to draw was the RIGHT one to
  draw — a board that colours by team when the reader cares about latency
  scores perfectly and answers the wrong question;
- whether the specific colour or icon was well chosen, which is a question
  about palettes and iconography that none of these columns can see.

The honest reading of the source, including its critics: PoN's own
operationalisation ranges from objective counts to subjective judgement, and
applying it properly is usually said to need user involvement that this
repository cannot supply. So the claim is fixed at the level the counting
supports — the same shape ADR-0032 fixed for composition, and for the same
reason.

### How it is used

- **Beside, never inside.** A facet column may not cancel a drawing-score
  debt or a composition owe, and neither may pay for one of these.
- **Never a gate**, like the other two: read beside a result.
- **Calibrated before it is believed** — a planted defect moves the column
  that names it and no other, a board that declares nothing is pinned as the
  blind spot, and the corpus's all-default reading is pinned as what it is.
- **Its scoreboard is the LANE's boards, not an invented corpus.** The
  drawing corpus has no board that spends this channel, so pinning one would
  mean hand-writing the fixtures that justify the axis — exactly how a
  fixture becomes the convention by accident, which this project has already
  refused once (ADR-0032's guide-line reading). What a model actually draws
  through the tool surface is the population this axis is about.

## Consequences

- The first reading is expected to be a wall of `deficit`, and that is the
  finding rather than a failure of the instrument. What it turns into is a
  question the loop can then ask properly: is the channel unspent because
  the tool surface makes it awkward, because nothing tells the model it
  exists, or because the drawings genuinely have no kinds worth
  distinguishing?
- A third axis is a third thing to keep honest, and three pinned scoreboards
  is where this stops being free. Any of them that stops earning its re-pin
  should be retired rather than carried.
- This axis will sometimes disagree with the other two — spending colour
  costs nothing geometric, so a board can improve here and move nowhere
  else, and a board can be beautifully composed and say nothing about kind.
  That is the point of three axes rather than an average.
- `contrast` in ADR-0032 becomes redundant in the strict sense once this
  lands: it is the shadow this axis casts on geometry. It stays
  reported-only there and is not removed, because a reading taken against it
  is on the record and a column deleted mid-series makes the older readings
  unreadable.

## Alternatives considered

**Extend ADR-0032's `contrast` into a real column instead.** Rejected: that
column reads the SCENE's resolved appearance against roles inferred from the
graph, and this axis reads the DOCUMENT's declarations against what was set
on it. Those are different inputs and different claims; folding them would
make one number that answers neither question.

**Score "how many facets are set", as a coverage number.** Rejected, and it
is the trap this ADR most needs to avoid. More facets is not better: the
redundant-encoding work says a second channel helps when it carries the same
distinction and confuses when it carries another, and Moody's excess is
precisely a symbol nobody asked for. A count would reward the board this
axis exists to catch.

**Ask an LLM whether the drawing distinguishes its kinds well.** Rejected as
the first rung, for the reason ADR-0032 rejected it: no deterministic pin,
no mutation check, and a judge from the same family as the drawer.

**Wait until a user study can validate it.** Rejected on ADR-0032's grounds:
the instrument can be honest about what it counts without one, and the
alternative in practice is not a study but another session deciding by taste
whether a drawing uses colour well.
