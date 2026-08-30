#!/usr/bin/env node
// Regression coverage for mutation-scope.mjs.
// Run with: pnpm test:scripts (also wired into the CI "check" job).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scopeToDiff } from './mutation-scope.mjs'

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
