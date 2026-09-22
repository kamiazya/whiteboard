import { readFileSync } from 'node:fs'
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
 * - a file ADDED to the list raises the count, which fails here and has to be
 *   argued for in the diff rather than slipped in;
 * - a file whose complexity has been brought under the threshold and whose
 *   exemption was not removed ALSO fails — an exemption that no longer
 *   exempts anything reads exactly like one that does, and leaves the next
 *   reader believing a file is worse than it is.
 *
 * Neither is a ratchet in the sense that was refused: an exempt file is
 * unconstrained, so ordinary work in one is not obstructed. What the list
 * buys is that everything NOT on it stays clean, without anyone having to
 * remember to enrol a directory after clearing it.
 */
// `layout/compose-node.ts` joined the list when it came out of
// `spatial-canvas.ts` carrying `composeNode` (22), and left it when that was
// paid down: the kind `switch` became a `satisfies Record<NodeKind, …>` table
// and the file node's four early returns became a ranked list of
// representations. The count is stated here and nowhere else, because several
// sessions pay the list down concurrently and a number in a comment goes stale.
const EXEMPT_COUNT = 121

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
  it('names exactly this many files, and the number only goes down', () => {
    expect(exemptions()).toHaveLength(EXEMPT_COUNT)
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
