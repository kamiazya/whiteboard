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
  'AGENTS.md': 16,
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
  // bought by about 480 characters of prose, not by drift — a coarse
  // instrument charges the whole step to whoever crosses it.
  '.claude/rules/dev-flow.md': 27,
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
 * Worth knowing when this fails on a diff that touches no rule file: the
 * total is the reading most likely to be stale, and the four `it`s below
 * separate the cases — a per-file failure names the file that grew, this
 * one names only the corpus.
 */
const ALWAYS_ON_TOTAL_BUDGET = 22

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
const CANVAS_RENDER_BUDGET = 80

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
