/**
 * A browser test resizes through `test-utils/viewport.ts`, never through
 * `page.viewport` directly.
 *
 * The reason is in that helper, and it is worth the rung because of how the
 * failure presents rather than how often it happens: CDP refuses to resize a
 * window that is in fullscreen, vitest does not deliver that rejection to the
 * caller, and the `await` never settles — so the test spends its whole 60s
 * budget and reports `Test timed out in 60000ms`. The message names the test
 * that asked and not the state that refused, the line it points at is fine,
 * and the real reason arrives separately as an "Unhandled Rejection"
 * attributed to no test at all.
 *
 * Nothing connects the victim to the cause: the fullscreen belongs to another
 * file, so the victim rotates, passes in isolation, and passes on a re-run of
 * the same commit. Two different tests were written off as flakes on that
 * evidence before the cause was measured.
 *
 * So this is a rule with nothing to burn down rather than a ledger: there is
 * one correct way to resize and the helper is it. A scan rather than a lint
 * plugin, because what makes the rule true is that ONE module owns the call —
 * which is a fact about the repo, not about any single file's syntax.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listTestFiles, TEST_SCAN_DIRS } from './test-scan-dirs.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

/** The one module allowed to call `page.viewport`. */
const HELPER = 'apps/web/src/test-utils/viewport.ts'

const DIRECT_CALL = /\bpage\s*\.\s*viewport\s*\(/g
const VIA_HELPER = /\bsetViewport\s*\(/g

function count(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length
}

describe('browser tests resize through the viewport helper', () => {
  it('counts each shape (self-test)', () => {
    expect(count('await page.viewport(375, 900)', DIRECT_CALL)).toBe(1)
    expect(count('await page . viewport (375, 900)', DIRECT_CALL)).toBe(1)
    expect(count('await setViewport(375, 900)', DIRECT_CALL)).toBe(0)
    expect(count('await setViewport(375, 900)', VIA_HELPER)).toBe(1)
  })

  it('is owned by one module, which really makes the call', () => {
    const helper = join(REPO_ROOT, HELPER)
    expect(existsSync(helper)).toBe(true)
    // Without this the rule below is satisfied by deleting the helper.
    expect(count(readFileSync(helper, 'utf-8'), DIRECT_CALL)).toBeGreaterThan(0)
  })

  it('has no test file calling page.viewport directly', () => {
    const offenders: string[] = []
    for (const dir of TEST_SCAN_DIRS) {
      for (const file of listTestFiles(join(REPO_ROOT, dir))) {
        // This guard names the pattern it hunts, in its self-test.
        if (file.endsWith('test-viewport-helper.test.ts')) continue
        if (count(readFileSync(file, 'utf-8'), DIRECT_CALL) === 0) continue
        offenders.push(
          `${relative(REPO_ROOT, file).split(sep).join('/')}: calls page.viewport directly — use setViewport from ${HELPER}, which clears the fullscreen that would otherwise hang the call for the whole 60s budget`,
        )
      }
    }
    expect(offenders).toEqual([])
  })

  it('reaches the population it governs', () => {
    // A scan that stopped matching reports a clean tree, which is exactly
    // what a passing run looks like. So the callers are counted too: the
    // rule means nothing if nothing resizes at all.
    const all = TEST_SCAN_DIRS.flatMap((dir) => listTestFiles(join(REPO_ROOT, dir)))
    expect(all.length).toBeGreaterThan(900)
    const callers = all.filter((file) => count(readFileSync(file, 'utf-8'), VIA_HELPER) > 0)
    expect(callers.length).toBeGreaterThanOrEqual(8)
  })
})
