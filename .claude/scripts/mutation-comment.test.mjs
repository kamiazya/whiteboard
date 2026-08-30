#!/usr/bin/env node
// Regression coverage for mutation-comment.mjs.
// Run with: pnpm test:scripts (also wired into the CI "check" job).
//
// What is worth pinning here is not the prose but the two ways this comment
// can mislead: counting a mutant nothing detected as if it were detected, and
// posting at all when there is nothing to say.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderComment, summarize } from './mutation-comment.mjs'

const MARKER = '<!-- test-marker -->'

const mutant = (status, over = {}) => ({
  mutatorName: 'EqualityOperator',
  replacement: 'a > b',
  status,
  location: { start: { line: 12, column: 1 } },
  ...over,
})

const report = (mutants) => ({ files: { 'src/a.ts': { mutants } } })

test('a report with no mutants renders nothing at all', () => {
  assert.equal(renderComment({ files: {} }, MARKER), '')
  assert.equal(renderComment(report([]), MARKER), '')
})

test('NoCoverage counts against the score, exactly like Survived', () => {
  // The failure this guards is a flattering number: a mutant no test even
  // executed is the most undetected a mutant can be, and dropping it from the
  // denominator would report 100% for a file nothing covers.
  const { score, counts } = summarize(report([mutant('Killed'), mutant('NoCoverage')]))
  assert.equal(score, 50)
  assert.equal(counts.NoCoverage, 1)
})

test('a timeout counts as detected, since the mutant made the code hang', () => {
  assert.equal(summarize(report([mutant('Timeout'), mutant('Survived')])).score, 50)
})

test('survivors are listed with file, line and the edit that survived', () => {
  const body = renderComment(report([mutant('Survived')]), MARKER)
  assert.match(body, /^<!-- test-marker -->/)
  assert.match(body, /`src\/a\.ts:12`/)
  assert.match(body, /EqualityOperator/)
  assert.match(body, /`a > b`/)
  assert.match(body, /HYPOTHESIS/)
})

test('a clean report says so instead of printing an empty table', () => {
  const body = renderComment(report([mutant('Killed')]), MARKER)
  assert.match(body, /nothing survived/)
  assert.doesNotMatch(body, /\| where \|/)
})

test('the table is capped, and says how many it left out', () => {
  const many = Array.from({ length: 25 }, (_, i) =>
    mutant('Survived', { location: { start: { line: i + 1, column: 1 } } }),
  )
  const body = renderComment(report(many), MARKER)
  assert.match(body, /…and 5 more/)
  assert.equal(body.split('\n').filter((line) => line.startsWith('| `src/a.ts')).length, 20)
})

test('a replacement cannot break out of its table cell', () => {
  // Arbitrary source lands in a markdown table: a newline would end the row
  // and a backtick would end the code span, so both are neutralized.
  const body = renderComment(
    report([mutant('Survived', { replacement: 'a\n|b|\n`c`' })]),
    MARKER,
  )
  const row = body.split('\n').find((line) => line.startsWith('| `src/a.ts'))
  // Four UNESCAPED pipes: the three column separators plus the closing one.
  assert.equal(row.replaceAll('\\|', '').split('|').length - 1, 4)
  assert.match(row, /a \\\|b\\\| 'c'/)
})
