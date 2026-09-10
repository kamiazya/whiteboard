import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Always-on rule prose is charged to EVERY session in this repo before any
// work starts, and almost none of it is guarded: across the five files below,
// what any test would notice losing is 283 characters over 18 literals —
// 0.32% of the corpus — split between `dev-rules-contract.test.ts` (the
// web-jsdom hazard) and `repo-coverage.test.ts`'s architecture-map doc-sync
// block (the shared-layer package names, the composition roots,
// `web-app-boundary.test.ts`, `cycle-check.ts`). So the budget is not
// protected by the suite as a side effect of anything else, and a section
// added in passing costs every future session silently.
//
// That figure was first written here as 0.15%, from a search of ONE test
// file, under a heading claiming to have measured what ANY test would notice.
// The doc-sync guard then caught a real omission this very file's author had
// made — which is how the undercount surfaced. Widen the search before
// trusting a coverage number: the conclusion survived, the number did not.
//
// This is the instrument, not a limit: the sizes are pinned so a change to
// them is a decision someone makes in a diff rather than drift nobody
// measures. Growth is legitimate — a rule that earns always-on status should
// be always-on — and so is a cut.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

/**
 * Buckets of 1000 characters, floored.
 *
 * Pinning the exact count is what this repo does for a list of modules, and
 * it is wrong for prose: a typo fix would fail the test, and a test that
 * fails on typos gets weakened until it means nothing. A coarse bucket keeps
 * an improvement exactly as loud as a regression — the property that matters
 * — while an ordinary clarification passes.
 */
const bucket = (chars: number): number => Math.floor(chars / 1000)

/**
 * The TOTAL is bucketed four times coarser than a single file, because it is
 * the one reading two independent diffs share.
 *
 * A per-file pin is crossed by the PR that edits that file, and its CI sees
 * the crossing — measured across both recorded failures of this suite, no
 * per-file pin was ever wrong. The total is different: it moves when ANY
 * always-on file grows, so two PRs that are each green on their own base can
 * cross it together, on a main neither one's CI ever ran against. This repo
 * has no merge queue (user-owned; the prep in ci.yml is dormant), so nothing
 * re-runs either PR against the other's result — the crossing is arithmetic
 * nobody decided, and it fails on main, asking whoever pushes next to make a
 * "decision" after the fact. That inverts what these pins are for.
 *
 * Both occurrences fired ONLY this assertion: run 33414443314 (2026-08-31,
 * 91723 chars, 90 -> 91) and run 33879487386 (2026-09-04, 88144 chars,
 * 87 -> 88). Both were cleared by bumping the number.
 *
 * A coarser grain does not close the class — every threshold has a boundary
 * — it makes the boundary rare enough that crossing one is usually a real
 * budget decision. At the 1000 grain the corpus sat NINE characters under
 * the next boundary when this was written, so the next concurrent pair of
 * prose PRs would have tipped it again. Equality is kept, so a cut is still
 * exactly as loud as a regression; only the resolution changed.
 */
const TOTAL_GRAIN = 4000
const totalBucket = (chars: number): number => Math.floor(chars / TOTAL_GRAIN)

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
}

/** A rule file is PATH-SCOPED when its frontmatter declares `paths:`. */
function isPathScoped(source: string): boolean {
  const frontmatter = /^---\n(.*?)\n---\n/s.exec(source)?.[1] ?? ''
  return frontmatter.includes('paths:')
}

function ruleFiles(): string[] {
  return readdirSync(join(REPO_ROOT, '.claude/rules'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `.claude/rules/${name}`)
    .sort()
}

/** Loaded in every session: AGENTS.md plus every rule file without `paths:`. */
function alwaysOnFiles(): string[] {
  return ['AGENTS.md', ...ruleFiles().filter((path) => !isPathScoped(read(path)))]
}

const ALWAYS_ON_BUDGET: Record<string, number> = {
  // 17 since the MCP section gained its three-line pointer at the
  // mcp-tool-surface skill; main sat 23 characters under the boundary, so
  // the bucket is bought by the pointer alone.
  'AGENTS.md': 17,
  // 16 since `packages/history` joined the table — the shared mechanics both
  // keepers read a branch, a merge plan and a checkpoint out of. A package
  // that is not in the table is a package nobody can place, so the row is
  // what every session needs; the package's own detail is path-scoped in
  // `package-history.md` and costs nothing here. The file sat ONE character
  // under the boundary, so 294 of the 295 characters this row added are
  // charged to a step it did not take — a coarse instrument bills the whole
  // bucket to whoever crosses it.
  '.claude/rules/architecture-map.md': 16,
  // 27 since `ci-gate` — the one required check ci.yml's jobs aggregate into.
  // It belongs here rather than in a skill because it changes what a session
  // must do when it shards a job: nothing, where before it had to ask a human
  // to rename a required check. The sentence also carries the two ways an
  // aggregate gate goes quietly wrong (a job missing from `needs`, a blanket
  // `skipped`), since the reader who adds a job is not the reader who opens
  // ci-gate.mjs. The file had 117 characters of headroom, so this bucket is
  // bought by about 515 characters of prose, not by drift — a coarse
  // instrument charges the whole step to whoever crosses it.
  // 28 since the mcp-tool-surface skill joined the "four things you cannot
  // see by reading a diff" list and the review workflow gained its opt-in
  // tool-surface dimension; the entry is trimmed to the pointer, and the
  // detail is the skill's.
  '.claude/rules/dev-flow.md': 28,
  // 14 since the CI-flakes section gained flake-watch's pointer — the
  // watcher for the section's own second-occurrence rule, whose value is
  // being discovered at session start rather than remembered. The file sat
  // 33 characters under the boundary, so the bucket is bought by one
  // sentence; the mechanism lives in the script's header, not here.
  '.claude/rules/integrator-flow.md': 14,
  // 16 since the annotation layer's thread vocabulary (ADR-0026) landed in
  // the Comment row. It sat 23 characters under the boundary beforehand, so
  // this bucket bought about 200 characters of prose, not a thousand — a
  // coarse instrument charges the whole step to whoever crosses it.
  '.claude/rules/vocabulary.md': 16,
}

/**
 * Floored bucket of the SUM at `TOTAL_GRAIN`, which is not the sum of the
 * per-file buckets.
 *
 * 22 = 88991 characters at a 4000-char grain. Was 88 at the 1000-char grain,
 * reached by two rounds of the cross-PR crossing described on `totalBucket`.
 *
 * 23 since `vocabulary.md` gained the **Proposal** row (ADR-0029). The corpus
 * stood at 91762 and one table row of 296 characters crossed the grain, which
 * is what the grain is for: the row is not what the budget is really about,
 * the 2771 characters that accumulated under it since 88991 are. Raised
 * rather than trimmed — compressing a standing vocabulary entry below what it
 * has to say, to sit under a bucket, is the trade this test exists to make
 * visible rather than to force.
 *
 * Worth knowing when this fails on a diff that touches no rule file: the
 * total is the reading most likely to be stale, and the four `it`s below
 * separate the cases — a per-file failure names the file that grew, this
 * one names only the corpus.
 */
const ALWAYS_ON_TOTAL_BUDGET = 23

/**
 * The largest path-scoped file, tracked separately because it is not paid by
 * every session — only by one that touches its package. It is listed alone
 * because at more than thirteen times the median package rule it is a budget
 * of its own; the rest are small enough that a total would hide them.
 */
// 78 since the label cut moved to grapheme boundaries. What bought the bucket
// is ~800 characters, and most of it is one dead end stated so nobody walks it
// again: a gate tighter than "any code point at or above U+0300" cannot be
// built, because "can this character join something" answers yes for every
// precomposed Hangul syllable. Raised rather than trimmed — this test exists
// to make crossing a bucket a decision, not to forbid it.
// 80 since decision #14, the `references/` module: what it holds, the rule
// that no root writes a seam's body, and the gap the layout worker leaves.
// Path-scoped, so paid only by a session in canvas-render — where the two
// thousand characters are the module's design record.
// 81 since the live-drag parity property's generator started reading the
// facet REGISTRY. What bought the bucket is the account of how that property
// shipped VACUOUS — plain nodes on both sides, agreeing about canvases that
// carried no facets at all, while the bug it exists to catch was live. A
// reader who does not know that will write the next generator the same way.
// 88 since the render theme layer (ADR-0030): the in-layout resolution
// that lets an embed read its own facet before the host's, the sketch ink
// decomposition and why it is seeded from ids, the glow filter's
// `userSpaceOnUse` region, the `style` default that keeps unstyled output
// byte-identical, and the second time the live-drag parity property
// shipped vacuous — nodes with facets, a canvas with none — each a
// decision the next theme has to keep.
// Plus the paint-order rule (groups behind what they hold, whatever the
// stored order says) — a bug a person saw in a rendered diagram and no test
// had caught.
// 90 since the drawing score: the one instrument that judges the BOARD
// rather than a mechanism, what it reads and where it is pinned, the
// `annotates` link a scene needs to get from a label back to what it
// names, and the first thing it found — tidy leaves every mistake inside a
// frame where it was — which tidy's own scoreboard cannot see.
// 91 once the column set was read against the literature: what a session
// extending it has to know (a column earns its place by an empirical
// ranking, not a catalogue; the vector stays a vector and the known blind
// spot is pinned), and the router finding the new columns surfaced.
// 92 for the sharing contract: the instruments read one polyline geometry,
// the router never does, and the duplication left between them is the
// independence — said where a session about to "deduplicate" it will read.
// 93 for the matrix of the two router changes the drawing score rejected:
// each cut the reference's reversals and raised the sweep's debt, and a
// table is what stops the same shapes being argued for again.
// 94 for the gap column: what the score reads between two boxes, and why
// tidy's margin is held at the same number.
// 97 for tidy inside a frame — the three rules around it each came from a
// measurement a reader would otherwise repeat — and for the traced search
// that shows the same-row loop is the cost model's answer, not a miss.
// 98 for the survivor judged by zero tests: six of six hand-checked were
// killed, so the column is read before the row.
// 99 for the ink terms reading axis-aligned segments only: the diagonal
// back through an edge's own box that the search could not see, the tier
// swap measured and rejected for it, and where the fix belongs and why.
// 101 for the named side pair the search overrules, the lone-edge gate it
// dropped and what that moved on the sweep, and the coincident-anchor
// decision that changed with it — each a measurement a reader would repeat.
// 102 for tidy banding on centres and far edges, and the drift the fixpoint
// loop fell into when such a snap could jam a unit — found by fast-check,
// and the kind of thing a reader re-derives by breaking it again.
// 103 for row order by edges: the measurement that made tidy the place for
// it, and the two affordances measured and withdrawn before it.
// 104 for the passes that CYCLE rather than settle: why the loop stops at a
// state it has already seen, and the four fixes aimed at the snap instead
// that measurement rejected — each one a session would otherwise re-try.
// 105 for membership by majority: the orphaned member no debt column could
// see, and why neither scoreboard caught it — the shape of blind spot a
// reader has to be told about, since the instrument reads clean.
// 106 for the margin-as-anchor attempt measured and rejected: it clears the
// two near misses a reader would want cleared, and flips the board's flow
// to `left` doing it, which is exactly the trade a later session would
// otherwise make again on the same reasoning.
// 109 for the flow vote that made that verdict wrong: why one vote per edge
// let an arrow near 45 degrees decide a board's whole reading, the first
// fix the corpus rejected in one run (weighting AWAY from the diagonal
// silences the diagonals a layered board is made of), and the rejection
// above re-priced against the corrected instrument — kept in full, because
// the first verdict was published and "rejected" alone would send the next
// reader after a number that has changed.
// 112 for the composition axis: its four columns and their sources, and the
// four things its calibration DECIDED — a group is a frame and not a
// component, `guides` alone is not a verdict, a tie counts as apart, and
// tidy is not promised to buy proximity. Each was measured out of a wrong
// first definition, which is the part a reader would otherwise redo.
// 113 for the guide-line attempt the composition score rejected on its
// first use as a decision instrument: the mechanism works on a constructed
// case and buys nothing on a corpus whose `offGuide` is already 0 — which
// is a statement about the CORPUS, and the next reader needs to know that
// before either retrying it or inventing the fixture that justifies it.
// 114 for the proximity owe measured and NOT chased: what the rule the
// column implies would cost (+15% ink, +19% envelope, systemic), and why
// the owe is mild — C1 scores only groups with a drawn border, and common
// region is a stronger cue than proximity. Both are things a later session
// would otherwise re-derive, one of them by shipping the change first.
// 117 for what the eval lane found that the corpus could not — the margin
// anchor pulling a member off another board's column — and for the standing
// frame-idempotence bug the same investigation surfaced, with the evidence
// that it predates this session and the three partial fixes that did not
// close it.
// 120 when that bug was CLOSED: the standing-bug paragraph became the fix —
// three measured changes, the structural one that was measured and dropped
// for costing 50% more time to reach the same answer, and the 11853-of-20000
// -> 0 reading either half of it has to be judged against. A later session
// asking "was that ever fixed, and what did it cost" reads it here rather
// than reconstructing it from four commits.
// 121 for where that fix's SETTLING CEILING came from: the pass
// distribution over 40000 boards, the six that never reach a fixpoint at
// all, and the fact that a guessed ceiling of 4 shipped and CI's stress
// lane found the board needing 5. A ceiling with no measurement beside it
// is the next session's guess as well.
// 124 for the THIRD axis (ADR-0033, `quality/facet-score.ts`): what a board
// says with appearance rather than with position, and the first reading of
// it — every board in the corpus, the hand-drawn references included, spends
// one treatment and owes all 22 constructs. A reader who does not know that
// will read the scoreboard's zeroes as health.
const CANVAS_RENDER_BUDGET = 124

describe('always-on rule context budget', () => {
  it('charges every session exactly the files this budget names', () => {
    // A new always-on rule file, or one that gains or loses `paths:`, moves
    // between the two budgets — and has to say so in the diff rather than
    // arriving as context nobody counted.
    expect(alwaysOnFiles().sort()).toEqual(Object.keys(ALWAYS_ON_BUDGET).sort())
  })

  it('holds each always-on file at its pinned size', () => {
    const drift = alwaysOnFiles()
      .map((path) => ({ path, chars: read(path).length }))
      .filter(({ path, chars }) => bucket(chars) !== ALWAYS_ON_BUDGET[path])
      .map(({ path, chars }) => `${path}: ${chars} chars = bucket ${bucket(chars)}`)
    expect(drift).toEqual([])
  })

  it('holds the always-on total at its pinned size', () => {
    const chars = alwaysOnFiles().reduce((sum, path) => sum + read(path).length, 0)
    expect(
      totalBucket(chars),
      `always-on corpus is ${chars} chars = bucket ${totalBucket(chars)} at a ${TOTAL_GRAIN}-char grain`,
    ).toBe(ALWAYS_ON_TOTAL_BUDGET)
  })

  it('holds package-canvas-render.md at its pinned size', () => {
    const chars = read('.claude/rules/package-canvas-render.md').length
    expect(bucket(chars), `package-canvas-render.md is ${chars} chars`).toBe(CANVAS_RENDER_BUDGET)
  })
})
