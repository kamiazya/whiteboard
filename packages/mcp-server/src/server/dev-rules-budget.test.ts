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
  '.claude/rules/architecture-map.md': 14,
  // 26 since the design checkpoints gained `benefit` — the column a change's
  // worth is claimed in, which decides how it gets verified. The entry sits
  // beside `blastRadius` and `userReach` because it is a peer required field,
  // and the file had 277 characters of headroom, so the bucket is bought by
  // one bullet rather than by drift. The three worked cases live in the
  // `measured-change` skill, which is not always-on and costs nothing here.
  '.claude/rules/dev-flow.md': 26,
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
 * Floored bucket of the SUM, which is not the sum of the buckets.
 *
 * 88 since two merges that were each green on their own base landed
 * together. `integrator-flow.md` grew past its own boundary (13 -> 14) in
 * one; `vocabulary.md` gained 204 characters in the other, which did not
 * move ITS bucket (16 either way) and moved the total, 87940 -> 88144. So
 * both per-file pins were correct and only this one was crossed, on a main
 * neither PR's CI ever saw — the second PR was branched before the first
 * landed, which is the one thing a per-PR check cannot cover.
 *
 * Worth knowing when this fails on a diff that touches no rule file: the
 * total is the reading most likely to be stale, and the four `it`s below
 * separate the cases — a per-file failure names the file that grew, this
 * one names only the corpus.
 */
//
// 89 since the skills index gained `testing-techniques` — 22 characters,
// on a corpus that sat 9 under the boundary. The skill itself and its
// path-scoped `test-authoring.md` rule cost nothing here: neither is
// always-on, which is the point of putting the technique catalogue in
// `resources/*.md` rather than in a rule.
const ALWAYS_ON_TOTAL_BUDGET = 89

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
const CANVAS_RENDER_BUDGET = 78

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
    expect(bucket(chars), `always-on corpus is ${chars} chars`).toBe(ALWAYS_ON_TOTAL_BUDGET)
  })

  it('holds package-canvas-render.md at its pinned size', () => {
    const chars = read('.claude/rules/package-canvas-render.md').length
    expect(bucket(chars), `package-canvas-render.md is ${chars} chars`).toBe(CANVAS_RENDER_BUDGET)
  })
})
