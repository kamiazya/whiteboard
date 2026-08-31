import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Always-on rule prose is charged to EVERY session in this repo before any
// work starts, and almost none of it is guarded: across the five files below,
// the only content any test would notice losing is the 163 characters
// `dev-rules-contract.test.ts` pins about the web-jsdom hazard — 0.15% of the
// corpus. So the budget is not protected by the suite as a side effect of
// anything else, and a section added in passing costs every future session
// silently.
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
  'AGENTS.md': 27,
  '.claude/rules/architecture-map.md': 17,
  '.claude/rules/dev-flow.md': 32,
  '.claude/rules/integrator-flow.md': 13,
  '.claude/rules/vocabulary.md': 15,
}

/** Floored bucket of the SUM, which is not the sum of the buckets. */
const ALWAYS_ON_TOTAL_BUDGET = 105

/**
 * The largest path-scoped file, tracked separately because it is not paid by
 * every session — only by one that touches its package. It is listed alone
 * because at more than thirteen times the median package rule it is a budget
 * of its own; the rest are small enough that a total would hide them.
 */
const CANVAS_RENDER_BUDGET = 77

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
