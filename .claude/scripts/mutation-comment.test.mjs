#!/usr/bin/env node
// Regression coverage for mutation-comment.mjs.
// Run with: pnpm test:scripts (also wired into the CI "check" job).
//
// What is worth pinning here is not the prose but the two ways this comment
// can mislead: counting a mutant nothing detected as if it were detected, and
// posting at all when there is nothing to say.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mutantKey, renderComment, summarize } from './mutation-comment.mjs'

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
  // Five UNESCAPED pipes: the four column separators plus the closing one.
  assert.equal(row.replaceAll('\\|', '').split('|').length - 1, 5)
  assert.match(row, /a \\\|b\\\| 'c'/)
})

test('a survivor says how many tests judged it', () => {
  // Stryker selects tests by relatedness, so a module few test files import is
  // judged by a handful — and its survivors are hypotheses rather than
  // findings. That distinction cost hours before the number was printed.
  const body = renderComment(report([mutant('Survived', { testsCompleted: 3 })]), MARKER)
  const row = body.split('\n').find((line) => line.startsWith('| `src/a.ts'))

  assert.match(row, /\| 3 tests \|$/)
  assert.match(body, /judged by/)
})

test('a mutant with no test count is marked as such, not as zero', () => {
  // A Timeout carries no count because it never finished. Rendering that as
  // `0 tests` would read as "nothing covers this line", which is the opposite
  // of what a timeout means.
  const body = renderComment(report([mutant('Survived')]), MARKER)
  const row = body.split('\n').find((line) => line.startsWith('| `src/a.ts'))

  assert.match(row, /\| — \|$/)
})

// --- KNOWN_EQUIVALENT ---------------------------------------------------
//
// A survivor that cannot be killed is a settled finding, and re-reporting it
// on every PR is how a comment teaches its readers to skip it — one file
// carries 23, more than the whole table holds. What must NOT happen is a mute:
// a recorded count is a ceiling, and the mutant past it is news again.

const sourced = (source, mutants) => ({ files: { 'src/a.ts': { source, mutants } } })
const SOURCE = 'const x = a > b\nconst y = c > d\n'
const gt = (status, line, column, endColumn) =>
  mutant(status, {
    replacement: 'a >= b',
    location: { start: { line, column }, end: { line, column: endColumn } },
  })

test('the mutant key names the ORIGINAL expression, not the line it sat on', () => {
  // A line number identifies a mutant only until something is inserted above
  // it, at which point every entry goes stale at once and the whole list comes
  // back as new survivors.
  assert.equal(
    mutantKey(SOURCE, gt('Survived', 1, 11, 16)),
    'EqualityOperator: a > b -> a >= b',
  )
})

test('a recorded equivalent is counted, not listed', () => {
  const known = { 'src/a.ts': { 'EqualityOperator: a > b -> a >= b': 1 } }
  const { survivors, settled } = summarize(sourced(SOURCE, [gt('Survived', 1, 11, 16)]), known)

  assert.equal(survivors.length, 0)
  assert.equal(settled, 1)
})

test('the recorded count is a CEILING — one more of the same mutation is news', () => {
  const known = { 'src/a.ts': { 'EqualityOperator: a > b -> a >= b': 1 } }
  const { survivors, settled } = summarize(
    sourced(SOURCE, [gt('Survived', 1, 11, 16), gt('Survived', 1, 11, 16)]),
    known,
  )

  assert.equal(settled, 1)
  assert.equal(survivors.length, 1)
})

test('a different expression is never covered by another entry', () => {
  const known = { 'src/a.ts': { 'EqualityOperator: a > b -> a >= b': 5 } }
  const { survivors } = summarize(sourced(SOURCE, [gt('Survived', 2, 11, 16)]), known)

  assert.equal(survivors.length, 1)
})

test('a recorded survivor still counts against the SCORE', () => {
  // Equivalent or not, the tests did not detect it. Discounting it would turn
  // the ledger into a way to buy a better number.
  const known = { 'src/a.ts': { 'EqualityOperator: a > b -> a >= b': 1 } }
  const { score } = summarize(
    sourced(SOURCE, [gt('Survived', 1, 11, 16), gt('Killed', 2, 11, 16)]),
    known,
  )

  assert.equal(score, 50)
})

test('a report of nothing BUT recorded equivalents says so instead of going quiet', () => {
  // Silence would read as "the lane did not run"; a table would read as debt.
  const known = { 'src/a.ts': { 'EqualityOperator: a > b -> a >= b': 1 } }
  const body = renderComment(sourced(SOURCE, [gt('Survived', 1, 11, 16)]), MARKER, known)

  assert.match(body, /Nothing NEW survived/)
  assert.match(body, /already recorded as equivalent/)
  assert.doesNotMatch(body, /\| where \|/)
})

test('an entry the run did not produce is reported, not silently kept', () => {
  // The ledger's other decay, and the half a source scan cannot see: the
  // expression is still in the file, so the entry looks live, while the run
  // no longer produces the survivor it records — most likely because a test
  // now kills it, which makes the entry assert something false.
  const known = { 'src/a.ts': { 'EqualityOperator: a > b -> a >= b': 1 } }
  const { unspent } = summarize(sourced(SOURCE, [gt('Killed', 1, 11, 16)]), known)

  assert.deepEqual(unspent, [
    { file: 'src/a.ts', key: 'EqualityOperator: a > b -> a >= b', left: 1 },
  ])

  const body = renderComment(sourced(SOURCE, [gt('Killed', 1, 11, 16)]), MARKER, known)
  assert.match(body, /did not show up/)
  assert.match(body, /a > b -> a >= b/)
})

test('a ledger the run spends in full reports no leftovers', () => {
  // The other direction, so the check above cannot pass by reporting always.
  const known = { 'src/a.ts': { 'EqualityOperator: a > b -> a >= b': 1 } }
  const body = renderComment(sourced(SOURCE, [gt('Survived', 1, 11, 16)]), MARKER, known)

  assert.doesNotMatch(body, /did not show up/)
})

test('leftovers are counted only for a file this run actually mutated', () => {
  // A diff-scoped PR run mutates a subset of the lane. Reading the ledger
  // instead of the report would flag every entry of every file the diff did
  // not touch, on every PR.
  const known = { 'src/b.ts': { 'EqualityOperator: a > b -> a >= b': 1 } }
  const { unspent } = summarize(sourced(SOURCE, [gt('Killed', 1, 11, 16)]), known)

  assert.deepEqual(unspent, [])
})

test('an empty ledger leaves the comment exactly as it was', () => {
  const mutants = [gt('Survived', 1, 11, 16)]
  assert.equal(
    renderComment(sourced(SOURCE, mutants), MARKER, {}),
    renderComment(sourced(SOURCE, mutants), MARKER),
  )
})
