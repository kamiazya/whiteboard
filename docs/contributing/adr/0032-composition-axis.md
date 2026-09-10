# ADR-0032: A composition axis — what a drawing hands its reader, judged by four principles with their sources

**Status:** Accepted — the criteria, the column definitions and the validity
claim; the score itself and its pinned scoreboard are the next increment.
Sits beside [ADR-0031](0031-tool-surface-criteria.md) §7's drawing score
rather than extending it.

## Context

[ADR-0031](0031-tool-surface-criteria.md) §7's drawing score judges a board
by DEBT (mistakes a reader would call mistakes: overlaps, an edge through a
box, a covered label) and PRICE (crossings, bends, reversals, ink, uneven
gaps, envelope, density). Over eleven rounds of the LLM-driven lane the debt
criterion **saturated** — `debtFreePowK` 1.0 for two rounds running — and
the loop moved to the price columns, where the remaining wins are small and
increasingly a matter of judgement.

Two things this session made the gap concrete.

**A verdict came from a column that was itself wrong.** A tidy change was
measured, rejected on a `flow` regression, and then re-measured after the
`flow` vote was corrected — at which point the regression was not there at
all. The lesson is not "check the instrument once"; it is that a score whose
columns were chosen for DEFECTS cannot be asked questions about
COMPOSITION, and will answer anyway.

**The questions being asked are compositional.** "Should tidy put a fan-out
hub between the boxes it fans out to?" and "should every frame's first
column sit on the same line?" are not defect questions. Nothing in the debt
set can answer them, and the price columns answer them only sideways, in
ink and gap counts. They were settled by argument and by a human looking at
a figure.

The user's direction (2026-09-10), from looking at one of those figures:
a placement rule that thinks in **guide lines** would read better, and —
separately from prettiness — the axis that matters is whether a drawing
**communicates**. The four principles of *The Non-Designer's Design Book*
(Robin Williams) — proximity, alignment, repetition, contrast — are the
organising frame, and each column is to be implemented from a credible
source rather than from taste.

## Decision

Add a **second axis**, scored beside the drawing score and never mixed into
it: four columns saying what composition a drawing hands its reader.

### What each column is, and what backs it

**C1 — PROXIMITY: does spacing encode the grouping the drawing declares?**
A reader groups by proximity whether the author meant it or not, and the
Gestalt-in-diagrams literature reports proximity easing diagram
comprehension. The drawing already declares its groups twice over: a frame
names its members, and the edge graph's connected components name a
cluster. The column reads, per declared group, the largest gap between
adjacent members WITHIN it against the smallest gap from a member to a
non-member, and counts the groups where the within-gap is not smaller —
spacing that contradicts the grouping. Source: the Gestalt principles /
diagram comprehension line of work.

**C2 — ALIGNMENT: how few guide lines does the drawing resolve to?**
Balinsky, Wiley & Roberts (ACM DocEng 2009) make alignment computable as
edge quality, connectivity, grid regularity and alignment statistics, and
argue that alignment quality is what separates professional layout from
amateur and machine-generated layout. The column clusters every box's six
anchors (left/centre/right, top/middle/bottom) to the half pixel, counts
the lines two or more boxes actually share, and counts the boxes on no
shared line at all. Distinct from the drawing score's `nearMisses`, which
prices a MISS: this prices the composition — a board of eleven boxes on
four lines reads as composed, the same eleven on nine lines does not.

**C3 — REPETITION: does the drawing reuse its own vocabulary?**
Ngo et al., *Modelling interface aesthetics* (Information Sciences, 2003)
gives fourteen computable measures with a reported correlation to perceived
aesthetics; regularity, homogeneity and rhythm are the ones this column
follows. It counts the distinct box widths, heights and gap sizes a board
uses, to a tolerance, against the number of boxes and gaps it has.

**C4 — CONTRAST: reported-only, and it says so.**
Contrast is the weakest leg to ground. Salience manipulations by luminance
contrast have shown no effect in some empirical work, and the diagram
studies that do find effects are about specific tasks rather than about
composition. The column is therefore **reported, never owed**: it may not
be cited as a reason to accept or reject a change, and no scoreboard row
targets a value for it. It exists so the axis is not silently three-legged,
and so a later reading has a number to look back at.

### The validity claim, stated so it cannot be over-read

This axis measures **the composition a drawing hands its reader**. It does
NOT measure whether the drawing was understood.

That distinction is the honest reading of its own sources. Ngo's measures
are validated against PERCEIVED AESTHETICS; SLC's visual cohesion is the
rarer case validated against usability; the Gestalt work is about
perceptual grouping rather than about the comprehension of a specific
diagram. None of them was validated on this product's drawings, and nothing
in this repository can close that gap: it needs people, tasks and a study.

So the ADR fixes the claim at the level the evidence supports, and the
module doc repeats it. A session may say "this change gives the reader a
more composed drawing, by these columns". It may not say "this change makes
the drawing easier to understand" on the strength of these numbers.

### How it is used

- **Beside, never inside.** The drawing score's debt and price columns keep
  their meanings. A composition column may not cancel a debt, and a debt may
  not be paid for with a composition gain.
- **Never a gate.** Like the drawing columns in the lane, it is read beside
  a result, not used to fail one.
- **Calibrated before it is believed**, the way `drawing-score.test.ts`
  calibrates the first instrument: a hand-drawn reference must beat its own
  draft on every column that is not reported-only; a planted defect must
  move only the column that names it; and the blind spot the set is known
  to have is pinned rather than hidden. An instrument trusted before it is
  calibrated is how `worstStallMs` came to report 0.3ms for a 200ms stall.
- **Pinned exactly** over the same corpus, so an improvement is as loud as
  a regression and whoever moves a number says why.

### What this axis deliberately does not cover, and where it will attach

The same question — does this drawing do its job — has a second half that
is not about where boxes sit: **whether the drawing uses the facet
vocabulary it has**. Colour, icon and the rest of `visual`'s facets
([ADR-0013](0013-facet-system.md)) are how a drawing says two things differ
in KIND rather than in position, and a board that distinguishes nothing
with them has left that channel unspent whatever its geometry scores.

That is a later phase (user, 2026-09-10) and probably its own ADR, because
it reads the facet registry rather than the scene's resolved appearance.
The seam it will attach to is C4: `contrast` as defined here counts the
treatments a scene ends up with against the structural roles the graph has,
which is the geometry-side shadow of the facet question. A facet-aware
column asks it directly — which facets are set at all, whether elements
sharing a role share a treatment, and whether a distinction a reader can
see corresponds to a distinction the document declares.

It is named here so the columns above are defined without closing that seam
off, and so a later reader knows the omission was scoped rather than
missed.

## Consequences

- The compositional questions the loop has been settling by argument get a
  currency. The first one waiting is a placement rule that snaps to
  board-wide guide lines rather than to per-scope bands — which is C2's
  column made into a rule, and will be judged by C2 rather than by the
  session that wrote it.
- A second axis is a second thing to keep honest. Two scoreboards already
  cost a re-pin with a reason on every change that moves them; this makes
  it three.
- The axis will disagree with the drawing score sometimes — a composition
  gain that costs ink is the expected shape. That is the point of keeping
  them separate, and each such trade is a decision someone has to make and
  record, not an average to optimise.
- `contrast` being reported-only will look like an omission to a reader who
  knows the four principles. The ADR says why in the column's own entry, and
  the module doc repeats it.

## Alternatives considered

**Extend the drawing score with more debt columns.** Rejected: these are
not defects. Folding them in would let a composition price cancel a real
mistake inside one aggregate, which is exactly the failure mode the debt
and price split was built to avoid.

**Ask an LLM whether the drawing communicates.** Rejected as the FIRST
rung, not forever. It has no deterministic pin, cannot be mutation-checked,
and would be judging drawings produced by the same family of model. The
LLM-driven lane already grades an outcome; a judge of composition on top of
it is a second opinion with no ground truth under it.

**Wait for a user study before measuring anything.** Rejected: the
instrument can be honest about what it measures without one, and the
alternative in practice is not a study — it is another session deciding a
composition question by taste and calling it obvious.

**Implement all fourteen of Ngo's measures.** Rejected on the same ground
ADR-0031 §7 rejected a metric catalogue: a column earns its place by
answering a question this project actually asks. Balance, symmetry and
equilibrium are about a page's mass around its centre, which is a poster's
problem and not a diagram's.
