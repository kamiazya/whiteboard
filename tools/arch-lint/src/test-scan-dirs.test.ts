/**
 * The scans ABOUT test files (titles, fixed sleeps, viewport helpers) are
 * only as wide as the directory list they walk, and a list that is too
 * narrow reports exactly what a wide one that found nothing reports: green.
 *
 * Measured when `TEST_SCAN_DIRS` stopped being hand-kept: 1568 tracked test
 * files covered, 1618 in the workspace. The 50 in the gap were invisible to
 * all three scans, in the two shapes a hand-kept list goes stale in — a
 * package created after it was written (`daemon-client` 29, `history` 3,
 * `scene` 1) and a test file kept outside `src` (`apps/web`'s own root 9,
 * its `scripts/` 7, `mcp-server`'s root 1). Nobody had done anything wrong;
 * nothing asked.
 *
 * So this file asks, from both sides.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TEST_SCAN_DIRS } from './test-scan-dirs.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

/**
 * Test files that are deliberately NOT scanned, each with the reason.
 *
 * The biome-plugin fixtures exist to CARRY the patterns the plugin's own
 * tests assert on, so a scan of them would report the fixture as the
 * defect. They sit outside every workspace package, which is why the
 * derivation already misses them — this entry says that is on purpose.
 */
const OUT_OF_SCOPE: Record<string, string> = {
  '.claude/scripts/fixtures/biome-plugin':
    'fixtures that CARRY the bad patterns, so a scan would report the fixture as the defect',
}

function trackedTestFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '*.test.ts', '*.test.tsx'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  })
    .split('\0')
    .filter((name) => name !== '')
    .sort()
}

describe('the test-file scan surface', () => {
  it('finds the repo it is scanning', () => {
    expect(trackedTestFiles().length).toBeGreaterThan(1500)
    expect(TEST_SCAN_DIRS.length).toBeGreaterThan(15)
  })

  it('covers every tracked test file, or records why not', () => {
    const uncovered = trackedTestFiles().filter(
      (file) =>
        !TEST_SCAN_DIRS.some((dir) => file.startsWith(`${dir}/`)) &&
        !Object.keys(OUT_OF_SCOPE).some((dir) => file.startsWith(`${dir}/`)),
    )

    expect(uncovered).toEqual([])
  })

  // The other direction: an entry that names nothing, which is how a
  // recorded exemption outlives the thing it exempts.
  it('records no exemption for a directory that no longer holds a test file', () => {
    const empty = Object.keys(OUT_OF_SCOPE).filter(
      (dir) => !trackedTestFiles().some((file) => file.startsWith(`${dir}/`)),
    )

    expect(empty).toEqual([])
  })

  it('names only real workspace packages', () => {
    const notAPackage = TEST_SCAN_DIRS.filter(
      (dir) => !existsSync(join(REPO_ROOT, dir, 'package.json')),
    )

    expect(notAPackage).toEqual([])
  })

  // A root dropped from the derivation takes a whole third of the repo with
  // it, and the population floors above are too coarse to notice `tools`.
  it('reaches every workspace root', () => {
    for (const root of ['apps', 'packages', 'tools']) {
      expect(
        TEST_SCAN_DIRS.filter((dir) => dir.startsWith(`${root}/`)).length,
        root,
      ).toBeGreaterThan(0)
    }
  })
})
