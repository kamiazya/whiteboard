import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * `noExcessiveCognitiveComplexity` is ON for this repository, and the files
 * that still exceed it are listed as exemptions in `biome.json`'s last
 * override.
 *
 * The list is SHRINK-ONLY, and this is what makes that true rather than
 * intended. Two directions, and the second is the one worth having:
 *
 * - the list may not grow past `EXEMPT_CEILING`, so enrolling a batch of
 *   files has to raise a number in the diff rather than slip in;
 * - a file whose complexity has been brought under the threshold and whose
 *   exemption was not removed ALSO fails — an exemption that no longer
 *   exempts anything reads exactly like one that does, and leaves the next
 *   reader believing a file is worse than it is.
 *
 * Neither is a ratchet in the sense that was refused: an exempt file is
 * unconstrained, so ordinary work in one is not obstructed. What the list
 * buys is that everything NOT on it stays clean, without anyone having to
 * remember to enrol a directory after clearing it.
 *
 * The second direction is the one with teeth, and until 2026-09-23 it was
 * PROSE: this comment claimed it while no test measured a file's complexity,
 * so fixing a file and forgetting its exemption left the count unchanged and
 * every check green.
 *
 * A CEILING rather than the exact count it replaced (user decision,
 * 2026-09-23) for a cost paid in merges rather than in code: several sessions
 * pay this list down at once, an exact count is the one line they all edit,
 * and #1828 hit that conflict three times, each costing a full CI run, with
 * nothing about the change itself in dispute. What a ceiling gives up is that
 * an addition can hide under slack a paydown left. What is left in its place
 * is not nothing: adding a path is visible in `biome.json`, and the
 * `complexity` review lane asks an added exemption to name the structure
 * considered instead. Lower the ceiling when a paydown leaves an obvious gap
 * — nothing forces it, which is the honest cost.
 */
// Lowered from 114 with codec's six files, then 72 -> 70 with the two
// document pages, 70 -> 67 with canvas-render, 67 -> 65 with daemon-client,
// 65 -> 60 with mcp-server's CLI, 60 -> 58 with the two keeper document
// Lowered from 114 with codec's six files, then 72 -> 70 with the two
// document pages, 70 -> 67 with canvas-render, 67 -> 65 with daemon-client,
// 65 -> 60 with mcp-server's CLI, 60 -> 58 with the two keeper document
// pages, 58 -> 55 with the markdown editor's three pure modules, 55 -> 52
// with the workspace-files panel and its two lists, and 52 -> 48 with the
// settings and migration surfaces: the comment asks for the ceiling to
// follow an obvious gap, and a paydown that leaves slack is exactly one.
const EXEMPT_CEILING = 48

function exemptions(): string[] {
  const config = JSON.parse(readFileSync(join(REPO_ROOT, 'biome.json'), 'utf8')) as {
    overrides: { includes?: string[]; linter?: unknown }[]
  }
  const override = config.overrides.find(
    (entry) =>
      JSON.stringify(entry.linter ?? {}).includes('noExcessiveCognitiveComplexity') &&
      entry.includes !== undefined,
  )
  if (override?.includes === undefined) {
    throw new Error(
      'biome.json has no override enabling noExcessiveCognitiveComplexity — the rule this ' +
        'guard exists for is not configured, so its count means nothing.',
    )
  }
  // The negations that name a real path; the `**/*.test.ts` family and the
  // positive globs are the override's SCOPE, not exemptions.
  return override.includes.filter((glob) => glob.startsWith('!') && !glob.includes('*'))
}

describe('the cognitive-complexity exemption list', () => {
  it('names no more files than the ceiling', () => {
    expect(exemptions().length).toBeLessThanOrEqual(EXEMPT_CEILING)
  })

  it('names only files that still exceed the threshold — a paid-down file leaves the list', () => {
    const paths = exemptions().map((glob) => glob.slice(1))
    // The list is the subject: an empty one would pass every assertion below
    // while measuring nothing.
    expect(paths.length).toBeGreaterThan(50)
    const over = filesOverThreshold(paths)
    expect(paths.filter((path) => !over.has(path))).toEqual([])
  })

  it('names each file once', () => {
    const named = exemptions()
    expect(new Set(named).size).toBe(named.length)
  })

  it('names files that exist', () => {
    const missing = exemptions()
      .map((glob) => glob.slice(1))
      .filter((path) => {
        try {
          readFileSync(join(REPO_ROOT, path))
          return false
        } catch {
          return true
        }
      })
    expect(missing).toEqual([])
  })
})

/**
 * Which of `paths` still hold a function over the threshold, measured by
 * biome under a ONE-rule config in a temp dir — `biome.json` switches the
 * rule off for exactly these files, so the repository's own config cannot
 * answer this. The threshold is read from that config rather than restated.
 * Measured: 0.55s for 117 files.
 */
function filesOverThreshold(paths: readonly string[]): Set<string> {
  const threshold = /"maxAllowedComplexity"\s*:\s*(\d+)/.exec(
    readFileSync(join(REPO_ROOT, 'biome.json'), 'utf8'),
  )?.[1]
  if (threshold === undefined) throw new Error('biome.json names no maxAllowedComplexity')
  const work = mkdtempSync(join(tmpdir(), 'complexity-exemptions-'))
  try {
    writeFileSync(
      join(work, 'biome.json'),
      JSON.stringify({
        linter: {
          rules: {
            recommended: false,
            complexity: {
              noExcessiveCognitiveComplexity: {
                level: 'error',
                options: { maxAllowedComplexity: Number(threshold) },
              },
            },
          },
        },
      }),
    )
    const report = lintWith(work, paths)
    const over = new Set<string>()
    for (const diagnostic of report.diagnostics ?? []) {
      if (diagnostic.category !== 'lint/complexity/noExcessiveCognitiveComplexity') continue
      const path = diagnostic.location?.path
      if (path !== undefined) over.add(path.replace(`${REPO_ROOT}/`, ''))
    }
    return over
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** biome's JSON report for `paths`, under the config in `configDir`. */
function lintWith(
  configDir: string,
  paths: readonly string[],
): { diagnostics?: { category?: string; location?: { path?: string } }[] } {
  let out: string
  try {
    out = execFileSync(
      'pnpm',
      [
        'exec',
        'biome',
        'lint',
        `--config-path=${configDir}`,
        '--reporter=json',
        '--max-diagnostics=none',
        ...paths,
      ],
      { cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
  } catch (error) {
    // biome exits non-zero whenever it reports anything, which is the expected
    // case here: every listed file should still be over.
    out = (error as { stdout?: string }).stdout ?? ''
  }
  return JSON.parse(out)
}
