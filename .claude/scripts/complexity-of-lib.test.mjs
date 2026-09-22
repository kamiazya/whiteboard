#!/usr/bin/env node
// Regression coverage for complexity-of-lib.mjs.
// Run with: pnpm test:scripts (also wired into the CI "check" job).
//
// The diagnostics below are the shape biome's `--reporter=json` actually
// emits for `noExcessiveCognitiveComplexity` — the span is the function's
// NAME, which is what makes cutting the name from the source reliable.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compare, formatTable, scoresFrom, thresholdFrom } from './complexity-of-lib.mjs'

const diag = (path, line, column, endColumn, score) => ({
  severity: 'error',
  message: `Excessive complexity of ${score} detected (max: 1).`,
  category: 'lint/complexity/noExcessiveCognitiveComplexity',
  location: { path, start: { line, column }, end: { line, column: endColumn } },
  advices: [],
})

const SOURCE = [
  'export function composeNode(node, options) {', // line 1: name at cols 17..28
  '  return [1].map((x) => x)', // line 2: an arrow, span `=>` at cols 21..23
].join('\n')

test('the threshold is read from biome.json, not restated', () => {
  assert.equal(thresholdFrom('{ "options": { "maxAllowedComplexity": 15 } }'), 15)
  assert.throws(() => thresholdFrom('{}'), /maxAllowedComplexity/)
})

test('a function is named by the span biome reports, and an arrow is anonymous', () => {
  const rows = scoresFrom(
    {
      diagnostics: [
        diag('a.ts', 1, 17, 28, 22),
        diag('a.ts', 2, 21, 23, 2),
        { category: 'lint/style/other', message: 'x', location: {} },
      ],
    },
    () => SOURCE,
  )
  assert.deepEqual(rows, [
    { file: 'a.ts', name: 'composeNode', line: 1, score: 22 },
    { file: 'a.ts', name: '(anonymous)', line: 2, score: 2 },
  ])
})

test('the delta joins by name, so a function that moved lines still compares', () => {
  const base = [{ file: 'a.ts', name: 'composeNode', line: 693, score: 22 }]
  const head = [{ file: 'a.ts', name: 'composeNode', line: 708, score: 3 }]
  const [row] = compare(base, head)
  assert.equal(row.base, 22)
  assert.equal(row.delta, -19)
})

test('two anonymous functions are never joined to each other', () => {
  // The case that produced a false "+1": a new arrow joined by the non-name
  // `=>` to an unrelated arrow in the base.
  const base = [{ file: 'a.ts', name: '(anonymous)', line: 40, score: 2 }]
  const head = [{ file: 'a.ts', name: '(anonymous)', line: 259, score: 3 }]
  const rows = compare(base, head)
  assert.equal(rows.find((r) => r.line === 259).base, null)
  assert.equal(rows.find((r) => r.line === 40).score, null)
})

test('a function that left a file reads as gone, not as missing', () => {
  const rows = compare([{ file: 'a.ts', name: 'old', line: 1, score: 18 }], [])
  assert.deepEqual(rows, [{ file: 'a.ts', name: 'old', line: 1, score: null, base: 18, delta: null }])
  assert.match(formatTable(rows, 15), /gone/)
})

test('the table shows what is over, near, or moved, and leaves out the rest', () => {
  const table = formatTable(
    compare(
      [
        { file: 'a.ts', name: 'moved', line: 1, score: 5 },
        { file: 'a.ts', name: 'still', line: 2, score: 4 },
      ],
      [
        { file: 'a.ts', name: 'over', line: 3, score: 16 },
        { file: 'a.ts', name: 'near', line: 4, score: 13 },
        { file: 'a.ts', name: 'moved', line: 1, score: 6 },
        { file: 'a.ts', name: 'still', line: 2, score: 4 },
      ],
    ),
    15,
  )
  assert.match(table, /^!\s+16.*over$/m)
  assert.match(table, /^~\s+13.*near$/m)
  assert.match(table, /\+1\s+a\.ts:1\s+moved/)
  assert.doesNotMatch(table, /still/)
})

test('against a base, a new function shows however low it scores, so moved complexity is visible', () => {
  // Measured on a real refactor: `pullEdgeOntoOutlines` went 25 -> 4 and the
  // helper it gained scored 8, which the near-threshold filter hid — so the
  // table showed a drop without showing where the rest went.
  const table = formatTable(
    compare(
      [{ file: 'a.ts', name: 'pull', line: 1, score: 25 }],
      [
        { file: 'a.ts', name: 'pull', line: 1, score: 4 },
        { file: 'a.ts', name: 'pullEnd', line: 9, score: 8 },
      ],
    ),
    15,
  )
  assert.match(table, /8\s+new\s+a\.ts:9\s+pullEnd/)
})
