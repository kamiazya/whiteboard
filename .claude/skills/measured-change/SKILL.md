---
name: measured-change
description: Build the measuring instrument before changing anything whose effect you cannot see by reading the diff — quality scoreboards (pinned aggregate metrics) and performance benchmarks (pnpm bench, interleaved runs). Use for optimisation, layout/routing quality, heuristic tuning, or any change where "did that help?" is a real question — AND for a structural change (moving work off a thread, unifying a pipeline, making a mistake uncompilable), where the numbers SIZE a benefit that end-to-end timing cannot show at all.
---

# Measure before you change it

Some changes announce themselves in the diff. A heuristic, a cost model, a
search, an optimisation does not: it is correct-looking code whose worth is
entirely in numbers nobody has taken. For those, **the instrument comes
first, in its own commit, and the change is judged by it.**

Which numbers, though, follows from what kind of benefit you are claiming —
and a structural change (work moved off a thread, a pipeline unified, a
mistake made uncompilable) needs different ones from a speed-up. That is the
next section, and it comes before everything else here.

This is not a preference. Across one routing/performance batch the
instrument rejected **three separate changes that were obviously right**:

- per-blocker detours — fixed 10 more defects, added 16 crossings; crossings
  are a higher tier, so it was a bad trade in the project's own currency
- a per-group placement cache — measured *slower* in all three rounds; the
  cached groups held two or three items and the key cost more than the work
- an excess-length penalty tier — a new cost term that argued well and moved
  no debt metric the corpus pins

Every one of them would have shipped on argument alone.

**And the instrument is not a veto — it prices.** An aligned re-score was
rejected in its first shape (a bespoke repair loop scoring whole
configurations, 13x layout time — it targeted 9 layouts in 400 and would have
charged every layout an extra pass), rejected again in its second (the same
loop reusing unchanged paths, 4.5x), and SHIPPED in a third that reused the search's
own incremental trial machinery, at 2x — `assignEdgeAnchors` now hands the
settled configuration back through the same search with `align: true`, and it
buys own-endpoint violations 35 -> 14 and crossings 647 -> 500. A measurement
that kills the first shape of an idea has not killed the idea.

That distinction is worth the words because this list used to end with the
re-score's FIRST verdict, as though it were the final one, while the third
shape was already in `spatial-edges.ts`.

## First decide WHAT KIND of benefit you are claiming

The instrument follows from the claim, and getting this wrong is not a
smaller measurement — it is a measurement of the wrong thing, which comes
back "no difference" and reads as "the change was worthless".

| claim | what it is worth | the instrument | the wrong instrument |
|---|---|---|---|
| **delta** — this is faster / lays out better | the difference in a number | bench, scoreboard | — |
| **relocation** — the work left the path a person waits on | what that path no longer does, **plus what the boundary costs** | the cost you removed from the critical path, and the cost of the handover | end-to-end duration |
| **elimination** — a whole class of mistake stops being possible | that the mistake now fails something | a count, or a mutation check | any duration |

Everything below this line is the **delta** column, which is the only one
this skill used to describe. The other two are not exempt from measuring;
they need different numbers.

### Relocation: the total does not move, and that is not a failure

Moving work off the thread that answers the user does not make the work
faster. Nothing gets faster. What changes is *who is blocked*, so an
end-to-end measurement of the outcome is structurally unable to see it, and
if that is the instrument you built you will report a null result about a
change that did exactly what it was for.

Worked case — moving a snapshot decode from the main thread into the layout
worker. The instrument that answered it:

- what the critical path stopped doing: decode measured **1.20ms at 12 nodes,
  2.60 at 40, 4.60 at 120**, so a list of twenty visible rows stopped charging
  24–92ms to the thread that answers the user;
- what the boundary costs: structured-cloning the decoded canvas was
  0.10/0.10/0.40ms, and cloning the **bytes** was not measurable at all.

That second row is the one a relocation must never skip, and it is what makes
this one a real release: a handover that costs what the work cost has moved
the block to the boundary rather than lifting it, and bought nothing. Measure
what you hand OVER, not only what you hand OFF.

And the honest null: the obvious instrument — a main-thread frame-gap probe
while a list fills — **could not detect this change**, 13ms against a 200ms+
spread between two runs of the same build. Reported as a null result it says
nothing about the change; it says the probe is far below the noise floor of
the thing it was pointed at. Say that, rather than reporting the null.

### Elimination: the number is a count, or there is no number

A change whose worth is that something can no longer happen is judged by
whether the something now fails. Two shapes in this repo:

- **A count, when the defect was repeated work.** The render broker's claim
  is not "rendering is faster" — it is that a row's thumbnail and the preview
  beside it produce **one** render for one key instead of two. Renders per
  key, not milliseconds.
- **A mutation check, when the worth is that a type or a single definition
  refuses the mistake.** `Record<DocumentKind, …>` over the surface registry
  is worth exactly as much as the compile error it produces, so the evidence
  is removing the guard and watching the build fail. A guard nobody has
  broken on purpose reads exactly like a guard that checked.

Neither is a weaker kind of evidence than a benchmark. Both can be faked the
same way a scoreboard can — a count taken over a run that never asked twice,
a mutation check on a path the fixture does not reach — and the discipline is
the same: choose the observation that could **refute** the claim
(`diagnosis-evidence`).

### Say which column you are in, in the commit and the PR

A relocation described as a speed-up is a claim the reviewer will check with
a stopwatch and find false, and the real benefit goes unstated. State the
column first, then the numbers, and name what the change does NOT claim.

## Quality: a scoreboard

For "does this look better", one canvas cannot answer — it says the fix
worked, never whether the failure moved somewhere nobody looked.

Build a corpus plus an aggregate. `packages/canvas-render/src/layout/edges/edge-routing-quality.test.ts`
is the worked example.

- **Metrics live in an independent oracle.** `test-utils/routing-metrics.ts`
  computes geometry directly and never calls the production scorer, so a
  broken rule cannot satisfy a test by agreeing with itself. Same contract as
  `test-utils/reversal-count.ts`.
- **Corpus = every reported defect, plus generated cases.** Generate DENSE:
  the defects only appear when things crowd, and a generator that spreads
  them out reports a clean score while drawing the same broken pictures.
- **Pin the numbers EXACTLY, not as a ceiling.** An improvement must be as
  loud as a regression — the point is that the number moves and someone says
  why. It is not a golden to regenerate.
- **Separate DEBT from PRICE.** Debt metrics (violations, ink through a body)
  target zero. Price metrics (bends, length, crossings) have no target and
  exist so a change that buys less of one harm with more of another cannot do
  it silently.

For a behaviour-preserving change, **the scoreboard not moving is the
proof**: an optimisation that leaves every pinned count identical, with no
expectation edited, has demonstrated it changed nothing but speed.

## Performance: `pnpm bench`

The bench API — a `bench` test-context fixture inside `test()` with `bench.compare`,
`toBeFasterThan`, `writeResult` and `bench.from()` baselines, `{ timeout: 0 }` on every
bench test, and why the project is filtered as `"canvas-render-node (bench)"` — is
`testing-techniques/resources/configuration.md` › Benchmarks.

`pnpm bench` (`packages/canvas-render/src/layout/edges/spatial-edges.bench.ts`),
never a hand-rolled `performance.now()` loop — you need the variance and the
sample count to know whether you measured anything.

### Interleave, or you are measuring the machine

Between-run drift on a loaded dev machine routinely exceeds the effect. Run
the versions alternately and compare paired rounds. Read the number from the
JSON reporter, not from the table: the table appends `fastest`/`slowest` to
some rows, so a column counted from the right lands on a different field per
row (the old `awk '{print $(NF-8)}'` recipe did exactly that).

```bash
# min latency (ms) of one bench, from .vitest/json/output.json
run() {
  pnpm bench --reporter=default --reporter=json <bench file> >/dev/null 2>&1
  node -e '
    const r = require("./.vitest/json/output.json")
    for (const f of r.testResults) for (const t of f.assertionResults)
      for (const b of t.benchmarks ?? []) for (const task of b.tasks)
        if (task.name === process.argv[1]) process.stdout.write(task.latency.min.toFixed(3) + " ")
  ' "<the bench name>"
}
for i in 1 2 3; do
  echo -n "AFTER  r$i: "; run; echo
  git stash push -q <changed file>
  echo -n "BEFORE r$i: "; run; echo
  git stash pop -q
done
```

`task.latency` carries `min`, `mean`, `p50`…`p999`, `rme`, `samplesCount`. The same
before/after can be done by the runner inside ONE table — `writeResult` on the current
registration, `bench.from('before', <path>)` beside it — which is still a same-machine,
same-sitting comparison and nothing more.

Report "faster in every paired round, median X → Y". A single before/after
pair is not evidence.

### A second bench in the same process is not a control

Benching a primitive alongside the thing you changed feels like a control. It
is not: they share a process, so **JIT warm-up couples them**. A change that
made the search call `routeEdge` 854 → 558 times left it colder when the
primitives bench ran, and it measured ~40% *slower* with its own code
untouched. Treat any movement in an untouched bench as a warning that the
comparison is contaminated, not as a result.

### Profile before hypothesising

The prediction was that 104 full-edge-set anchor recomputations were the
bulk. Measured: **16ms of 290ms**. The real cost was elsewhere entirely, and
a large refactor was nearly built on the wrong target. Time the phases first,
even crudely.

Counting is often better than timing. `routeEdge` calls: 854, of which 296
were byte-identical repeats — that number said "memoize" far more clearly
than any flame graph.

## Deciding a trade

When a change buys one metric with another, the project's declared ordering
decides it, not the size of the win. `PENALTY_RULES`' tiers are that
ordering: paying tier-2 debt for a tier-3 gain is a bad trade however good
the ratio looks.

When the ordering does not settle it — the currencies are genuinely
different, or the declared order is itself in question — **that is a human
decision**, and it is worth interrupting for. State both columns and the
concrete counts, and recommend one. ("42% less ink through a box, 8% more
crossings" was decided by a human in ten seconds; guessing it would have
been a coin flip.)

## A decomposition is a measured change too

"This file is 700 lines" is an argument, not a measurement, and it is the
one an audit reaches for when it has run out of defects. The number that
decides a split is **how much body an extraction removes against how many
identifiers cross its seam** — because a component whose extracted half
needs fourteen props has moved lines without moving knowledge, and the
reader still has to hold both files at once.

Calibrate against the split this repo ACCEPTED rather than against a number
you like. `CanvasContextMenu`'s four extractions measured, in lines per
crossing identifier:

| extraction | lines | seam | ratio |
|---|---|---|---|
| `color-row` | 73 | 3 | 24.3 |
| `edge-menu-items` | 155 | 8 | 19.4 |
| `node-menu-items` | 433 | 32 | 13.5 |
| `canvas-menu-items` | 117 | 14 | 8.4 |

So ~8 is the floor an accepted extraction has cleared, not a bar invented
here. Measured against it, the two components a maintainability audit
flagged next were both **rejected**:

- `HeaderBranchChip` (663 lines) — rename dialog 43 lines / 10 crossing
  identifiers = **4.3**, delete dialog 49 / 7 = **7.0**, both under the
  floor. And the ratio is the smaller objection: its `SCOPE RESET` effect
  clears eight state slices on `[workspaceId, path]`, so an extraction that
  takes the state with it breaks the invariant, and one that leaves the
  state behind is the prop-drilling those ratios are measuring. There is no
  version that both pays and preserves.
- `DaemonDetectedBanner` (741 lines) — only the LNA gate rows clear the bar
  (57 lines / 3 = **19.0**); the port row is 7.8 and the failure notices
  9.7. But its nine decision functions are ALREADY extracted into
  `lib/` with their own tests (`decideConnectGate`, `explainProbeFailure`,
  `deriveCapabilityTier`, `shouldShowDaemonCta`, …), so what is left is
  wiring and copy. Of the 34 tests, 12 assert on those rows and every one
  of them is about WHEN the row appears, not what it says — so the reader
  the extraction would serve does not exist.

Two things generalise. **Count the seam, not the props you would like to
pass**: a fair count is every identifier the extracted body reads that is
declared outside it, callbacks and setters included. And **ask what is left
after the pure decisions are already extracted** — when the answer is
wiring plus user-facing prose, a split relocates prose between files and
reduces nothing a reader must hold. Both files are ~535 lines of code under
a comment ratio of 15-22%; their size is where their explanations live.

## Before a big rewrite, ask whether the target is reachable

Cheapest experiment in the batch: for every route still cutting through a
node, does a clean path exist at all? A throwaway BFS answered **67 of 68**,
which said the remaining debt was a candidate-generation problem and not a
cost-model one — redirecting the work and retiring a planned task outright.

Ask "is this even fixable, and by what class of fix" before building the fix.
