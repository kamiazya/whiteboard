#!/usr/bin/env node
// Regression coverage for mutation-scope.mjs.
// Run with: pnpm test:scripts (also wired into the CI "check" job).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { scopeToDiff } from './mutation-scope.mjs'

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const PREFIX = 'packages/canvas-render/'
const CURATED = ['src/svg/format.ts', 'src/tidy.ts']

test('keeps a changed file the lane curates', () => {
  assert.deepEqual(scopeToDiff(CURATED, [`${PREFIX}src/tidy.ts`], PREFIX), ['src/tidy.ts'])
})

test('drops a changed file the lane deliberately does not cover', () => {
  // seed.ts is excluded because its report is known wrong; a diff touching it
  // must not drag it back in through the PR path.
  assert.deepEqual(scopeToDiff(CURATED, [`${PREFIX}src/layout/seed.ts`], PREFIX), [])
})

test('ignores changes in other packages', () => {
  assert.deepEqual(scopeToDiff(CURATED, ['apps/web/src/App.tsx'], PREFIX), [])
})

test('an empty intersection prints nothing, so the job can skip itself', () => {
  assert.deepEqual(scopeToDiff(CURATED, [''], PREFIX), [])
})

test('a glob in the curated list throws instead of matching nothing', () => {
  // Silently scoping to zero files looks identical to "this diff changed
  // nothing", which is the one way this script could hide the lane entirely.
  assert.throws(
    () => scopeToDiff(['src/**/*.ts'], [`${PREFIX}src/tidy.ts`], PREFIX),
    /cannot intersect a glob/,
  )
})

// --- the range the scope is computed over ---
//
// `scopeToDiff` is only as honest as the file list handed to it, and the
// workflow computes that list with `git diff`. A TWO-dot range against
// `pull_request.base.sha` is where the base branch stood when the PR opened,
// not the merge base — so once the base moves ahead, everything that landed
// on it in between reads as a file THIS diff changed.
//
// Measured on #1293, which touched `apps/web` and `docs/` only: the two-dot
// range reported six curated `canvas-render` files and the three-dot range
// reported none. The lane ran and attributed ten survivors in a file that PR
// never opened to that PR. The lane's whole stated purpose is that its PR
// signal is trustworthy, so the input needs a guard as much as the filter.
//
// The same trap is already recorded for dev-loop in `.claude/rules`: it
// "reviews a merge-base range, not a moving two-dot range".

/** The `git diff` whose output becomes `--changed-from`. */
function scopeDiffLines() {
  return readFileSync(path.join(REPO_ROOT, '.github/workflows/mutation.yml'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('git diff') && line.includes('changed.txt'))
}

// A regex that quietly stops matching reads exactly like a passing guard, so
// the count is asserted on its own before anything is concluded from it.
test('the workflow still computes the scope from a git diff', () => {
  assert.equal(
    scopeDiffLines().length,
    1,
    'expected exactly one `git diff ... > /tmp/changed.txt` in mutation.yml — if it moved, this guard is now reading nothing',
  )
})

test('that diff is a merge-base range, so a moving base cannot widen the scope', () => {
  const [line] = scopeDiffLines()
  assert.match(
    line ?? '',
    /"\$BASE"\.\.\."\$HEAD"/,
    `expected a three-dot (merge-base) range, got: ${line}`,
  )
})
