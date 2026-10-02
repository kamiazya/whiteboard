# canvas-render: design decisions and measurements

The history behind [the canvas-render rule](../../../.claude/rules/package-canvas-render.md):
what each standing rule was measured on, which alternatives were tried and refused,
and the incidents that shaped it. The rule keeps what a session editing
`packages/canvas-render` has to know; this page keeps why, and what finding out cost.

Every passage here was cut from the rule at a sentence boundary and is filed under the
heading it came from, so a rule that ends mid-argument continues in the section of the
same name below. A passage is in the rule or here, never both. Figures are as measured
when the decision was taken and describe the code of that day; the rule, the tests and
the scoreboards are what is current.
## What belongs here

### The scene-node union and the shape table

#### The claim this section used to open with

What DID change (human gate; see `git log` for when) is the claim this paragraph used to
open with: that a plugin seam was not needed here because "a new rendering
behaviour is a plugin declaration plus a small composer change". The second
half was the problem — a plugin could not add a silhouette without someone
editing this package, so the extension point was this repo's own commit
history.

### layout/edges

#### How the edge layer came to be four modules

That split was declined once (a three-module decomposition
across an eight-entry-point seam, on the file most likely to change next)
and then made when the file reached 2483 lines, three times the budget,
and the seam was MEASURED rather than read: the search reads the side
vocabulary, the anchor pass and the router, and none of the three reads
the search or each other except for two stub constants, which moved to
the vocabulary.

## Resolved design decisions

### 3. FontDescriptor / TextMetrics shape

#### Why the fallback measurer is script-aware

Measured, a uniform ratio put `これは日本語です` at 56.8px against
a true 128px, and `wb_scene_digest` answered `truncated` absent for a node
the editor was painting a fade on. The predicate is exported because a
second estimator exists — the text-wrapping scoreboard's corpus measurer,
which keeps its own Latin ratio but must agree about which code points are
wide, or the same canvas breaks its lines differently depending on which
one laid it out.

### 5. Document envelope

#### Option sanitization

Option sanitization keeps `renderSceneToSvg` total per this
package's never-throw rule: non-finite/negative `padding` -> `0`;
non-finite or negative `width`/`height` -> the derived fallback; a
`viewBox` with any non-finite field, or a negative `w`/`h` (SVG forbids
a negative width/height on `viewBox`, unlike `x`/`y` which may be a
negative offset), -> derived instead of the caller's value.

### 6. The `shape` node and optional resolved `Appearance`

#### Degenerate-value fallbacks

Degenerate-value fallbacks, all "omit, never
throw": a color/font-family that is not a non-empty string -> omitted; a
non-finite or negative `strokeWidth`/`fontSize` -> omitted (zero is a
legitimate value and is kept); `radius` emits `rx` only when finite and
`> 0` (SVG rejects a negative `rx`, and `rx="0"` is pure noise); a shape
whose `bbox` has any non-finite field renders as the empty string rather
than reaching `formatCoord` (which throws by contract) — zero-size and
negative-w/h boxes DO render (valid, invisible SVG), only non-finite is
dropped.

### 8. The theme layer

#### The export font-family defect

This decision also fixed a verified, separate defect: export's label
appearance used to declare `fontFamily: 'sans-serif'` while its measurer
(`measure-text.ts`) actually measured a vendored Roboto face, so the
emitted SVG's `font-family` attribute named a different font than the one
its coordinates were computed from.

### 10. The render-style seam

#### Why border-tracing and endpoint-body-ink sit below crossings

border-tracing sits BELOW crossings rather than adjacent to
overlap-and-intrusion: the SEARCH evaluates it against unaligned TRIAL
paths (`computeAnchorsFor`'s pre-`slideAlongSide` representation),
whose unaligned anchor placement can coincidentally trace a
bystander's extended border for a real stretch — a false signal a
genuine crossing never produces (verified against
`edge-lane-rank.test.ts`'s sweep-rank pin: tier 1 placement adopted a
route with a real crossing over a crossing-free one).
endpoint-body-ink sits below border-tracing for the same
trial-path-artifact reason. Both tiers are re-read against REAL
geometry by the aligned second run described below, which is where a
border trace that survives into the drawn route gets repaired.

#### The second search run: its cost and what it buys

It costs roughly 2x layout time on a
pathological 200-edge canvas (measured 190ms -> 405ms; 46ms -> 78ms at
40 edges) and buys own-endpoint violations 35 -> 14, crossings
647 -> 500, interior ink 3545 -> 2192. Both passes matter: one pass
leaves `foreign` violations WORSE than not running it at all. Two
earlier shapes of this same idea were measured and discarded — a
bespoke repair loop scoring whole configurations (13x layout time),
then the same loop reusing unchanged paths (4.5x). What made it
affordable was reusing the search's OWN incremental trial machinery
instead of writing a second scorer beside it.

#### Why regions: what the gate used to skip

`CROSSING_OPT_MAX_EDGES` (200) used to skip
side-choice optimization wholesale, which is not a small loss: measured
on a 345-edge clustered canvas, 331 avoidable-ink violations — one per
edge — against 29 across the ~4400 edges of the entire small corpus.
That is the size an AI-authored document reaches, so the size where
optimization stops being affordable is not the size where quality stops
mattering.

#### Regions: the measured result

Result on that canvas —
violations 331 -> 183, interior ink 42623 -> 21001, border ink
889 -> 554, at 12ms -> 622ms.

#### Regions: the region-size curve

The measured curve on that canvas is 200 -> 183
violations, 120 -> 158, 80 -> 122, with time rising 1023 -> 1184 ->
1481ms: SMALLER regions buy quality, because `TRIAL_BUDGET_EDGES`
applies per region, so the real knob is total trial budget and the
region size is only how it is spent. Tuning it against one synthetic
canvas would make that canvas the convention by accident; the curve is
recorded here so the next person can move it on evidence.

#### Batch (Jacobi) side-choice evaluation: the measurements and the re-measurement

The batch form
scores every trial edge against ONE base configuration, so a round is
order-independent and parallelisable, then adopts the non-conflicting
subset. Sound multi-adoption needs more than disjoint touched sets: a
pair spanning two proposals changes score and neither proposal costed
it, so their BOUNDING BOXES must be disjoint too — then every such pair
scores zero on both sides and the batch equals sequential adoption
exactly.
Measured over the corpus: batch needs 6 rounds to converge (12 is
identical), and at 6 it MATCHES sequential on avoidable-ink violations
(29) while beating it on crossings (473 vs 500) and ink (2169 vs 2192).
At the same 2-round budget it is far worse (47 violations, 611
crossings) — the extra rounds are how it pays for re-basing less often.
The cost is +36% layout time single-threaded (4471ms vs 3287ms over the
corpus). That is the whole finding: batch is quality-competitive and
strictly more work on one thread, and its extra work is exactly the
work a parallel executor could absorb.
Deferred rather than shipped because `canvas-render` is a shared-layer
package with no worker, no SIMD path, and no `navigator.gpu` (a DOM
global this layer forbids) — so today it would buy a 36% regression for
a few percent of crossings.
**Re-measured 2026-08-22 on the then-current search, and the case for
a parallel executor did not survive.** Batch re-implemented (best
candidate per edge against one base, disjoint old+new bounding boxes,
merged configuration re-evaluated) needs ~24 rounds to match the
sequential search on avoidable ink, not 6, and at that point costs
4x (345 edges) to 10x (200 edges) the sequential time in interleaved
`pnpm bench` — not +36%. Profiled, pair scoring — the only part a GPU
can take, because trial shapes are generated on the CPU — is 46% of
the 200-edge batch time and under 10% everywhere else; anchors,
routing and trial bookkeeping are the rest. A WGSL pair-scoring kernel
was built anyway and held bit-identical to the CPU narrow phase
(`scoreQuantizedSegmentPair`): 8-10x faster than the CPU at 100k+
pairs on a real GPU, equal to it on SwiftShader, with a ~2.7ms floor
per dispatch against rounds of 27-79k pairs. Amdahl's law then puts the
best achievable batch+GPU layout at ~2.4s for the 200-edge case the
sequential search does in 0.6s. No production router found (libavoid,
ELK, yFiles, Excalidraw) parallelises this step; the comparable one
(Excalidraw's elbow arrows) shrank the routing search space instead.
Both experiments were left on local branches (`batch-side-choice`,
`webgpu-pair-scorer`) that were never pushed and are not reachable
from this repository — so the paragraph above, not a branch, is what
has to carry the conclusion. Enough to rebuild either: the batch form
is the one described under the 2026-08-14 measurement (best candidate
per edge scored against ONE base configuration, adopted where old and
new bounding boxes are both disjoint, merged configuration
re-evaluated), and the kernel is one WGSL compute shader over
`scoreQuantizedSegmentPair`'s integer narrow phase — which is exactly
why that function was made integer-only and is documented as
reproducible by a second implementation.

#### The CPU-side costs the profile named, and what moved the target

Two of the four are done:
`addCost`/`lessCost` allocation (the trial sums into one scratch
array) and `routeEdge`'s repeated `deriveDefaultSides` scan.
`computeAnchorsFor` is done: it gave up its layout-invariant half
(node index, rects, centers, hoisted into an `AnchorContext` built
once per search), and its partition is now patched per trial rather
than rebuilt (`patchAnchorGroups`). Timing its three phases is what
made the second half tractable — grouping 15.4ms, placement 27.2ms,
alignment 3.8ms of 46.4ms on the 200-edge bench — because it showed
alignment could stay a FULL pass. That is the part worth remembering:
the hard question was which edges' alignment a re-side can flip
(the aligned run's slide reads group SIZES), and at 8% of the
function it never had to be answered. `selfPenalty` was measured
rather than assumed and the answer moved the target: its cost is
overlap-and-intrusion (10.9% of layout), not border-tracing (3.1%),
and that term now rejects by axis before measuring.
**All four are landed, and re-profiling afterwards moved the target
off that list entirely.** On the 345-edge clustered canvas — the size
an AI-authored document reaches — `routeEdge` is now 60% of layout,
and inside it the fallback chain is nearly all of that: the grid
search `routeOnGrid` 27%, `bestCandidate` 8%, the detour `region`
union 5%. The elbow shortcut, which the code is written around as the
common case, is taken on only 292 of 1215 routings there; the grid
search runs on 719 of them. On the 200-edge grid canvas none of this
shows (routing is 13%, pair scoring 22%) — so the two bench shapes
now disagree about where the time is, and a change judged on one of
them has not been judged.

#### The routed-path cache that was first written one scope too wide; the obstacle preparation that was rejected

**It was first written one scope too wide, and the reason is worth
keeping.** A cache owned by `assignEdgeAnchors` measured exactly the
same, so nothing flagged it: regions PARTITION the edge list, an edge
is routed in only the region that holds it, and `routeCacheKey` starts
with `edge.id` — so a later region can never hit an earlier one's
entry. Measured 0 cross-region hits on canvases of one, two and four
regions. The wider scope bought nothing and held every completed
region's paths until the layout finished. The gap in the reasoning was
specific: soundness was checked (may these searches share?) and
usefulness was not (do they ever have anything to share?). A sharing
change needs both, and the cheap way to get the second is to attribute
the hits, not to count them.
**The obstacle preparation was tried and rejected**, the second
measurement in this series to refuse a change that argued well.
`routeEdge` rebuilds two 286-element arrays per call — the
endpoint-containment filter and the margin-inflated copy — 1333 times
per clustered layout, and only 421 of those filters drop anything.
Memoizing the inflated array and returning the shared one untouched
when nothing is dropped measured neutral-to-negative (clustered
494/502/491 against 508/470/485ms, rounds disagreeing in sign; grid
slightly worse in all three). The 11% the phase profile attributes to
those two lines is the SCAN, not the allocation: 1333 calls x 286
rects x two `containsPoint` tests is 760k tests, and the prototype
keeps every one of them. Nothing here gets cheaper without cutting
the obstacle SET down spatially, which changes what is tested rather
than how fast it is tested.
A note on method, because it cost a wrong conclusion before it was
caught: the first interleaved run said the grid canvas regressed 3-4%
consistently, in all three rounds. Running the same pairs with the
ORDER FLIPPED said neutral. Whichever variant runs first in a round
carries that round's warm-up, and three rounds of a fixed order
reproduce the artifact rather than test it. Alternate the order, not
only the variant.

#### routeOnGrid: the profile and the obvious answer that was refuted

The profile pointed at it (27% of layout on the
clustered canvas), and the plan was to cut the obstacle SET down
spatially, as the rejected prototype's post-mortem above suggested.
Measured inside the function, that was already done: its window filter
keeps 31 of 287 rects, and costs 0.3% of layout to do it. The time was
the search itself — 161k heap pops per layout, 331 per call over grids
averaging 422 cells — expanding the grid blind because the priority was
`g` alone.

#### routeOnGrid: A* is not free

Worth 8-11% on the clustered canvas, five of five interleaved
comparisons in both orders; neutral on the grid canvas.

#### A*: the equal-cost tie-break, measured

Over
7419 generated cases the two never disagreed about what an optimal route
costs — never worse, never better — and disagreed about which one to
draw in 10-30% of them. On the 345-edge canvas exactly 2 of 345 edges
then settled on different sides, which is what moved that scoreboard's
violations 99 -> 100 and interior ink by 1.1%; the corpus-wide debt
metrics did not move at all.

#### A*: the two attempts to buy the tie-break back

Two attempts confirmed it: a lower-g heap tie-break (paths differing 394
-> 408, i.e. worse) and a canonical predecessor on equal-cost relaxations
(394 -> 363, i.e. barely moved). The second failure is the instructive
one — canonicalising among the alternatives requires having LOOKED at
them, which is the exact work A* skips.

#### The per-trial pair loop: the profile

After A* the two bench canvases stop agreeing about what is
expensive, which is itself the finding: on the 345-edge clustered canvas
`routeEdge` is 47% and the trial's pair loop 11.5%, while on the
200-edge grid canvas routing is 10.5% and the pair loop is **55%** — of
which only 22.5% is `pairScore` itself, leaving ~32% in the loop's own
bookkeeping. That loop walks every edge per touched edge (309k
iterations per layout on the grid canvas) computing a key, three map
probes and a bounds test just to reject.

#### The per-trial pair loop: the three variants

Interleaved in both
orders: a Set-per-touched-edge version was 8% WORSE on the grid canvas;
hoisting an accidental O(E) scan out of the query made it 10% worse;
an allocation-free version (stamp array plus scratch list) settled at 6%
worse on the grid canvas and 4% better on the clustered one.

#### Obstacle pruning: the profile and what it paid

The same
re-profile that named the pair loop also split `routeEdge`: on the
clustered canvas `routeOnGrid` is 16.3% after A*, `bestCandidate` 7.2%,
the endpoint-containment filter 7.1% and the detour `region` union 4.6%.
Only `routeOnGrid` prunes; the others each walk all 286 rects, and
`routeOrthogonal` walks that set six to fifteen times per call — two
elbow clearance tests, `crossedBy`, and `bestCandidate` up to three
times, each testing its ranked candidates. One extra pass to build a
small set buys ten cheap ones. Measured 10-13% on the clustered canvas,
five of five in both orders; within noise on the grid canvas, where 58
obstacles leave nothing to prune.

#### Why the pair-loop index does not pay

The reason is in the fixture's own documentation: the stride canvas is
the worst case for spatial pruning, where **55% of edge pairs survive a
bounding-box test**. The index therefore returns nearly everything, so
the binary search, the walk and the stamp writes are all paid on top of
visiting the same edges — and a flat `for (let j = 0; j < E; j++)` with
an inline bounds test is simply cheaper per element than an indexed walk
with an indirect read. Gating the index on a density estimate would buy
the clustered 4%, and would also be a threshold tuned against two
synthetic canvases, which is how one of them becomes the convention by
accident. Not worth 4%.

### 13. `parseBody` defaults to codec; what cannot wrap is cut

#### The grapheme gate and the CRLF join

CRLF is the ONE join below U+0300 and it shipped unhandled, because the
check swept candidate joiners against nine hand-picked predecessors —
exhaustive in one direction only, and `\r` was not among the nine. It now
sweeps both, in ~600ms against 2.2s pairwise: one segmentation per
candidate over every sub-U+0300 predecessor (a join can only LOWER the
segment count), then each suspect re-tested pairwise, since that probe
also flags a candidate that joins what FOLLOWS it.

### 15. A canvas's theme is resolved in layout, per canvas

#### Sketch ink: chords and the tick-mark finding

Curves are
inked from chords whose control point sits on the TRUE arc — measured
before that, per-vertex jitter on a 24-sample ellipse read as tick
marks.

#### Sketch ink: what makes it read as a hand

Three things make it read as a hand rather than a tremor, each pinned
by a test that a constant reverts: a side's bow is PROPORTIONAL to its
length (rough.js's rule, capped at `BOW_MAX_PX`) — an absolute 2.4px bow
left a 600px frame ruler-straight while a 60px chip wobbled; each pass
is ONE continuous sub-path whose vertices are displaced once and shared
by the sides meeting there, closing `OVERSHOOT_PX` past its start, where
four independently shaken sides left every corner an open gap; and the
backend paints the second pass at `SECOND_PASS_OPACITY`, since two
full-strength hairlines read as a ruled line drawn twice. The weight
itself is the theme's `strokeWidthPx` token (facet-engine), mapped onto
node chrome and edges by `theme-asset.ts` and never onto a label; sketch
declares 1.4. An edge keeps EVERY vertex the flattener produced and
gains an anchor only along a straight run longer than `EDGE_STEP_PX`
(`anchored`); the resampler it replaced kept one point per step, which
erased a hop (nine samples over ten pixels) and any bend inside the
step, so a sketched edge crossed other edges flat and cut its own
corners. A vertex's shake shrinks with its spacing, so the hop's dense
samples are not shaken into a burr. A hatched node draws its slant and
pitch from its own seed near one base (`HATCH_ANGLE_SPREAD`,
`HATCH_GAP_SPREAD`) and keeps the preset TINT under the lines — a label
sits on a coloured surface, not on bare accent strokes — and a coloured
group is inked but never hatched, since a frame is not a filled box. The
themed pixel golden is the instrument that sees all of this.

#### Glow: what a halo blooms from

What a halo has to
bloom from is the theme's `strokeWidthPx` — a 1px stroke blurred peaks
at a quarter of its opacity — and neon's default strokes carry HUE per
kind, since the halo repeats the stroke colour and a grey one read as a
smudge; an unpainted board was the one thing on the theme that did not
glow (`themes.test.ts` pins the chroma and the per-kind difference).

### Contributable edge routers

#### The reader-selection measurement, second half

(The measurement had a second half that no longer holds, and saying so keeps
the first half readable: the payload SAMPLES went empty too, because the
generator derived them from the same form. Since 2026-09-09 it draws from
the Zod schema instead, so a widened union would still be generated. The
editor half is the one that stands.)

## Tests and the mutation lane

### The live-drag parity property

#### How it shipped vacuous three times

It shipped
vacuous three times, once per target: plain generated nodes, no
silhouettes on either side, while every edge into a shaped node floated
off it for a whole drag; then nodes with facets and a canvas with none,
while a themed board's edges dragged crisp and straight; then, when
ADR-0013's edge target opened, edges with none — per-edge routing and the
bends a contributed router drew never reached a compared canvas (bends are
a field of the edge since ADR-0037 slice 4, so the schema-derived generator
draws them without anyone asking it to). The
second is why the scenario also draws `style`: a theme is drawn under
`'document'` and never under the library's clean default.

#### The generator before the schema-derived one

The generator
drew from form-derived samples until 2026-09-09 — a finite list with no
shrinking and nothing the form could not express — and that is the
history behind the first guard's wording.

### The routing scoreboard

#### Why a scoreboard and not one canvas per defect

Four reported defects were
each pinned by the one canvas that exposed it, which could never say
whether a fix moved the failure somewhere nobody had looked.

### The mutation lane

#### A differential oracle shares what it imports: the measurement

The third failure mode the lane found, and the least visible of the three,
because the property reads as the strongest kind there is. `edge-crossing-
sweep`'s oracle is the full O(E^2) scan — deliberately, since the sweep's
claim is exact equality with it — but both sides call the same
`scoreSegmentPair`, so every mutation inside the narrow phase changed the
oracle and the subject together and the property stayed green. Measured: 38
survivors on that file, 22 of them in that one function. The fix is not a
denser domain but a SECOND oracle that shares no code — the same
specification solved with different machinery (exact BigInt rationals
against sign-normalized cross-multiplication), plus a deterministic example
per comparison the reference cannot pin on its own — four clearance ends,
four endpoint incidences, one diagonal length. 83.1% to 89.3%, and every
mutant still standing is equivalent (below).

#### A flaky suite inflates the score: the measurement

The mirror of the false SURVIVOR above,
and harder to notice because it moves the number the right way. Measured on
`edge-crossing-sweep`: the y-gate mutant (`if (…) continue` -> `if (false)`)
came back Killed in one run and Survived in the next three — and deleting
that gate by hand leaves all 983 canvas-render tests green, so the kill was
an unrelated flake charged to it. Two more mutants behaved the same way.
A score therefore has a noise floor: two back-to-back runs of the same tree
differed by one mutant (89.33% vs 88.89%), and a run against a STRICTLY
larger test set scored lower than an earlier one.

#### A false survivor on a widely-covered file

A NARROW selection is not required for that to happen, which is the part
the `seed.ts` story understates. Measured on `scene-digest.ts`: the mutant
turning `minY = Math.min(...)` into `Math.max(...)` came back Survived from
a run that Stryker itself lists as covered by 33 tests across five files —
including a differential oracle that catches it 6 times out of 6 when the
same edit is applied by hand. Within that one file the number of tests
actually completed per mutant ranged from 1 to 57 (the five files hold 57),
with 75 mutants judged on a single test. That number is now PRINTED — the
sticky comment's `judged by` column is the mutant's own `testsCompleted`,
so the weak signal is visible on the row rather than inferred from knowing
which files import what.

#### The zero-test survivor: the `default` arm entry

The file's one recorded equivalent went with it: the
`default` arm's mutant was a TIMEOUT in both runs, never a survivor, so
the entry was suppressing nothing.

#### The `tidy.ts` ledger entries, and the margin entry that was dropped

The `tidy.ts` entries the ledger does hold were
each judged by all 42 and reasoned: `<=` on a floor admits exactly the
coordinate the shift then lands on, so the mutant costs a no-op
iteration and nothing else; skipping a zero delta is a guard around an
addition of zero. The margin's `<=` was one of them until a centre or
far-edge snap began reading the margin to decide whether it may move:
the report said the entry "did not show up", the edit applied by hand
moved the grouped scoreboard, and the entry was dropped.

#### A survivor location can be a sub-expression: the worked case

`edge-crossing-
sweep.ts:85` reported `ConditionalExpression -> true` on a three-way `&&`,
and replacing the whole condition failed 19 tests — the mutant was columns
22-33, the middle conjunct alone, which needs a segment that BEGINS on a
lane and slants away to distinguish.

#### A file with no instrument: the `tidy.ts` measurement

`tidy.ts` sat at 52.63% with a suite that pins separation,
grid-snapping, idempotence and determinism — every one of them true, and
none of them able to see the thing most of that file does. Measured:
forcing the overlap-resolution axis to one direction keeps all of those
green while total displacement over a fixed corpus goes 51647 -> 77469, a
50% regression in how far tidy drags a person's boxes. The file was a
QUALITY heuristic wearing correctness clothing, and the answer was the
instrument this package already prescribes — `tidy-quality.test.ts`, debt
metrics targeting zero and price metrics pinned exactly, over a seeded
corpus chosen to CROWD. 52.63% -> 80.70%, and the residue moved from the
heuristic into `buildUnits`.

#### The equivalent mutants of the crossing sweep

Of the 18 left on that file after the second oracle, 14 cannot be
killed by any test: the broad phase is an optimisation whose comparisons are
non-critical in one direction (widening the candidate set cannot change a
sum whose non-interacting terms are zero) and safe in the other (two boxes
meeting exactly after a quarter-pixel inflation each are half a pixel apart
before it, so they share no point), `hi > lo` and `hi >= lo` differ only
where the value is zero either way, and `dx === 0` falls through to a
`hypot` that is exact for it.

## Tidy and the drawing score

### Tidy inside a frame

#### The first reading of the drawing score

The first reading found what tidy left: a frame and what it holds moved
as ONE unit, so an overlap or a near miss INSIDE a frame survived a tidy
that cleared the straddle and the hidden label beside it, and a `tidy`
scoped to a frame's members (`within`) moved nothing at all — measured on
the lane's fixture before the fix, `[]` for both.

### Bands

#### The price of reading every anchor

Price:
displacement +10% on the plain corpus, +3% grouped, every debt column
unchanged.

### Cycles

#### The seven-box canvas with no fixpoint

The
idempotence property (seed 1329482316) drew a seven-box canvas with no
fixpoint at all — a band snap moves a box right, the overlap pass hops it
back, and a second box's band follows a partner that moved: period 3
(524↔528, 597↔608↔617). Stopping at the iteration cap returned whichever
of the three states the cap's parity landed on, and a second tidy resumed
the cycle.

#### The four rejected fixes

Four fixes were rejected by
measurement before that one, each aimed at the SNAP rather than the loop:
hoisting `lined` across iterations, and persisting it and clearing it when
the overlap pass moves the unit, both left `offGrid 1` (the PARTNER moves,
not the unit); guarded anchors on iteration 0 only broke six centre-band
examples, since the grid fallback undoes centre alignment; and seeding
`lined` with every unit already on an anchor read `offGrid 81` and moved
both scoreboards.

### The flow vote

#### The distance-from-diagonal weighting that the corpus rejected

The first fix tried was weighting a single vote by distance FROM the
diagonal, and it was rejected by the corpus in one run: the architecture
reference — a plainly top-down board — read `right` with `againstFlow` 5,
because a layered diagram carries its layering in DIAGONAL edges (a client
box down to the gateway) and the only axis-aligned edges are the two
inside a row. Silencing the diagonals silences the structure.

#### What the corrected vote also fixed

What the correction also fixed was already written down and unacted on:
`sequence/drafted` read `flow: right, againstFlow: 2` where its own
reference read `up`, and the row's comment said why — "a tie, which goes
to `right` by the fixed order". A draft was being charged two arrows
against a flow the tie-break had invented. It now reads `up` with nothing
against it, like the reference it is a draft of.

### The margin anchor

#### The measurement, and the verdict taken from a corrected instrument

`architecture/tidied` reads `nearMisses` 2 to 0 with
ink 2047 to 2019; `lane/architecture-tidied` pays ink 1881 to 1902 and
`unevenGaps` 2 to 4; grouped displacement 127141 to 127187, 46px over the
whole corpus. Debt down, price mixed — the ordering §7 gives.

**Its history is the case for taking a verdict from a corrected instrument
rather than from the run that produced it.** Measured first against the OLD
flow vote it also read `flow` `down` to `left` with `againstFlow` 0 to 2 —
a layered diagram that no longer reads top-down — and it was rejected on
that row alone. That row was the instrument's: one vote per edge let an
arrow near 45 degrees decide the board's reading (see the flow paragraph
above), and against the corrected vote `flow` and `againstFlow` do not move
at all. What was left was a design question rather than a measurement —
tidy had promised, in a pinned example, that a frame padded to 40 was
padded and it would leave it alone — and the user took it: land it, rewrite
the promise (2026-09-10). The example now pins the opposite, and names what
superseded it.

### A unit's members

#### The straddler that tidy orphaned: the measurement

A box drawn across a frame's edge belonged to
no unit under containment: it became a singleton, and the overlap pass
hopped it clear of the frame entirely — so tidy answered a straddle by
ORPHANING a member outside the group its author drew it in, and JSON
Canvas membership is containment, so the drawing had quietly lost a
member. Nothing caught it: every debt column of the drawing score reads
zero on the result, `straddles` included, precisely because the box no
longer touches the frame at all; and `tidy-quality`'s `membersLeftBehind`
counts only a box that was fully inside BEFORE, so a straddler leaving
was never a member leaving. Measured on `architecture/tidied`, where
`search` (640..840 across a frame ending at 800) settled below Services,
between it and Storage: claimed instead, it stays in its row and the
frame grows to 872 to hold it — crossings 1 to 0, bends 1 to 0, ink 2663
to 2047 (a fifth), envelope 824x884 to 872x772 (8% less area), and
`unevenGaps` 2 to 3, which is what the wider frame costs. Displacement
over the grouped corpus fell 143650 to 127141: a claimed box is tidied
among its fellows, a few pixels, instead of being hopped clear of a whole
frame.

#### The grouped scoreboard after the change

The grouped scoreboard's
`stillOverlapping` went 283 to 0 with this, its `unitTornApart` column
replaced by `membersLeftBehind` (members may now settle inside a unit;
what must not happen is one ending outside it).

### The margin anchor yields

#### The eval-lane finding

Round 12, three trials of three,
deterministic: a model wrapped a new chain in a group on a board whose own
row starts at x=0, `region.set` put the frame at -40, and the first member
was snapped from 0 to the margin at -8 — 8px off a row it had been lined up
with. `debtFreePowK` 1.0 to 0.8, and the corpus never saw it because no
corpus board has a frame straddling another board's column.

### Tidy settles

#### The idempotence bug: the measurement

This was a standing bug for a long time and the fix is worth reading as one
piece. On a board with a FRAME tidy was not idempotent — measured over 20000
crowded generated boards (one or two frames, 2-7 boxes, locks, scopes and
edges), **11853 moved again on a second tidy**, and 43 in 3000 grew a frame
by 1-4px on every tidy for ever. Both idempotence properties generated PLAIN
boxes, so nothing the frame passes do had ever been under one; the bug
predates the margin anchor and dates from when tidy began tidying inside
frames.

#### The settle-pass ceiling: the measurement and the guess CI caught

Over 40000 boards drawn as the property draws them (one or two
frames, a lock always, a partial scope half the time), reaching a repeated
state took 2 passes on 34885, 3 on 4759, and 7 at the worst — and 6 of
those 40000 never reach a FIXPOINT at all, which is why the stop is at a
state already SEEN. A ceiling of 4 shipped and `stress-changed-tests`
found the board needing 5 within the hour: a locked frame overlapping a
scoped one, each pass moving a member the next had to grow a frame around.

#### The frame pass inside the level loop: measured and dropped

It is the obvious structural fix and it works: it settles far
more boards in one pass (400 of 20000 still needed a second, against 1394).
It is also 50% slower for the same answer — 2.4s against 1.6s over the
sweep, 56ms against 45ms on the big board — with every scoreboard column
identical, because the second settling pass is cheaper than doing that work
on every iteration.

#### The result of the settling change

Result: **0 of 20000**, and the grouped `tidy-quality` displacement 127187 ->
125615 with every debt column unchanged. The drawing corpus moves on price
only (`architecture/tidied` ink 2019 -> 2068, `lane/architecture-tidied` 1902
-> 1893) and the composition axis reads the same change as `worstRatio` 1.4
-> 1.16 — the proximity owe narrowed, not paid.

### Guide lines

#### Why board-wide guide lines were rejected

The idea is sound and the mechanism worked: cluster every input anchor at
`TIDY_BAND_PX`, keep the clusters two or more nodes hold, and let a unit
that would take the bare grid take a line the board already nearly has
instead. A constructed case passes that nothing else can fix — a second
column in one frame and a second column in another, 8px apart, which bands
cannot see because they run among a frame's members and among the frames,
never across them.

It buys nothing on the corpus. `offGuide` is already 0 on nine of eleven
boards and `perGuide` 2.6-3.0, so alignment is not where these drawings are
weak; the measured movement was `worstRatio` 1.4 to 1.33 and 0.29 to 0.24
and one board's `perGuide` 2.67 to 2.83, with `apart` and `offGuide`
unmoved. Against that it broke two things: a member snapped to its frame's
margin was pulled back off it by a guide 8px away, and the idempotence
property failed on two seeds — the guide set is read from the input, tidy
changes the input, and a second tidy re-clusters into a different set. Made
convergent, it would need the guide set to be a fixpoint of tidy, which is
a substantially larger change than the one being justified.

## The composition score

### Tidy is not promised to buy proximity

#### The obvious fix, measured

**The obvious fix was measured and not taken.** The rule the column
implies is that a group's clearance to its neighbours must exceed its own
widest internal gap; on this board that is Storage moving down 144px, and
the result reads `apart` 1 to 0 and `worstRatio` 1.4 to 0.73 for ink 2019
to 2322 (+15%) and envelope 872x772 to 872x916 (+19% area), with every
other column unmoved. Systemic, since it would apply to every board with a
wide frame.

### Edge labels and router findings

#### The two rejected router changes: cause and matrix

The cause
is real: for an aligned offset `l-pair-crowding-tie-break` offers no
L-pair, so an edge whose lane holds a box has only the facing pair and
same-side U-hooks, and `optimizeSideChoices` adopts the FIRST candidate
that lowers the whole cost, not the best. A `lane-l-pairs` candidate rule
(four L-pairs when a box sits in the shared lane, first for every
lane-sharing pair, then gated on a blocked lane) and a best-of-candidates
adoption were each read on the reference, the 2000-layout sweep and the
clustered board:

| change | reference reversals | reference debt | sweep own-endpoint / interiorInk / borderInk | clustered violations / interiorInk / borderInk |
|---|---|---|---|---|
| none | 3 | 0 | 12 / 2083 / 824 | 100 / 11578 / 266 |
| lane-l-pairs, gated | 1 | 1 edge through its own source, 23px | 13 / 2165 / 856 | 100 / 11596 / 457 |
| best-of-candidates adoption | 1 | 0, at one new crossing | 14 / 2352 / 761 | 86 / 10327 / 516 |

Neither L candidate was ever adopted — the reference's improvement came
from `e5` reaching a top-to-top hook that a differently ordered search
finds — and each change raised a debt column on the population. The
drafted board also lost under the second (reversals 1 to 3).

#### The same-row loop: the traced search

The
lane's architecture board puts a gateway in the same row as the two
services it fans out to, one of them past the other: the straight
`api→auth` plus a top hook for `api→search` crosses the three client
edges arriving diagonally at the gateway's top (crossings 2), the under
hook crosses `auth→sqlite` (crossings 2), and the route through the 40px
gap crosses the straight edge (crossings 1) — so the only zero-crossing
configuration is the bottom-bottom loop for `api→auth`, and the search
finds it (`[0,0,0,0,0,3,6]` against the best single-edge alternative
`[0,0,1,0,0,2,4]`). Crossings outrank reversals and bends by tier, so
this is the drawing the model asks for; what would change it is the
placement (a gateway in its own row), which is the drawer's, or the tier
order, which is a population-wide change nothing here has measured.

#### The tier swap that was measured and rejected

The tier
swap that looked like the answer was measured first and rejected:
endpoint-body-ink above crossings moved nothing on that board, because
the term was blind either way, and on the sweep bought `own-endpoint` 12
to 5 for crossings 494 to 686 — a row for the matrix above.

#### The lane board after the overrule

The lane board with the sides the model
named is debt-free (`edgeThroughNode` 2 to 0, bends 6 to 4, reversals 4
to 2).

## The facet score

### Columns

#### Why `undeclared` was split out of `excess`

`undeclared` was split out of `excess` on 2026-09-19 (user decision, ADR-0033
addendum) because with `partitions: 0` there is no class to cut, so EVERY
spent treatment fell to `excess` by construction — the column could not tell
a meaningless decoration from a well-drawn undeclared board, and reported the
second as the first. It is silent on the whole pinned corpus, which is
undressed; the reading that found it is the eval lane's.

### The legend

#### Why the band exists

Measured before the band: the panel sat over the first box of every tagged
board.
