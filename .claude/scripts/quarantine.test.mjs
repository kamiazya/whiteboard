// Quarantine budget: a flaky test may be parked (`it.skip` + a QUARANTINE
// marker naming a whiteboard issue) but the parking lot is BOUNDED — Fowler's
// cap — so quarantine cannot become the graveyard it always decays into
// unbounded. Cap and age both fail this suite, which runs in check:local and
// CI's check job via `pnpm test:scripts`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { judgeQuarantine, parseQuarantineMarkers, scanRepoQuarantine } from './lib/quarantine.mjs'

const NOW = Date.parse('2026-09-05T00:00:00Z')

test('parses a QUARANTINE marker with date, issue and reason', () => {
  const src = `
// QUARANTINE(2026-09-01 wb:issues/version-timeline-flake): focus contention, root-cause pending
it.skip('flaky case', () => {})
`
  assert.deepEqual(parseQuarantineMarkers(src, 'a.test.ts'), [
    {
      file: 'a.test.ts',
      line: 2,
      date: '2026-09-01',
      issue: 'wb:issues/version-timeline-flake',
      reason: 'focus contention, root-cause pending',
    },
  ])
})

test('a marker missing the issue reference is itself a violation', () => {
  const src = "// QUARANTINE(2026-09-01): no ticket\nit.skip('x', () => {})\n"
  const markers = parseQuarantineMarkers(src, 'b.test.ts')
  const verdict = judgeQuarantine(markers, NOW)
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join('\n'), /issue/)
})

test('a marker with no parseable date fails, and is not silently age-exempt', () => {
  for (const date of ['not-a-date', '2026-13-40']) {
    const verdict = judgeQuarantine(
      [{ file: 'c.test.ts', line: 1, date, issue: 'wb:x', reason: 'r' }],
      NOW,
    )
    assert.equal(verdict.ok, false, `date ${date} must not pass`)
    assert.match(verdict.problems.join('\n'), /parseable/)
  }
})

test('within cap and age: ok', () => {
  const markers = [{ file: 'a', line: 1, date: '2026-09-01', issue: 'wb:x', reason: 'r' }]
  assert.equal(judgeQuarantine(markers, NOW).ok, true)
})

test('a marker older than 14 days fails with its file named', () => {
  const markers = [{ file: 'old.test.ts', line: 3, date: '2026-08-01', issue: 'wb:x', reason: 'r' }]
  const verdict = judgeQuarantine(markers, NOW)
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join('\n'), /old\.test\.ts/)
  assert.match(verdict.problems.join('\n'), /14/)
})

test('more than 8 quarantined tests fails on the cap', () => {
  const markers = Array.from({ length: 9 }, (_, i) => ({
    file: `f${i}`, line: 1, date: '2026-09-04', issue: 'wb:x', reason: 'r',
  }))
  const verdict = judgeQuarantine(markers, NOW)
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join('\n'), /cap/i)
})

test('live repo scan: reaches the real test surface, and the budget holds', () => {
  const { markers, scannedFiles } = scanRepoQuarantine()
  // The subject-is-present floor: a glob that stops matching reports itself
  // as "0 quarantined" — which is what a broken scan looks like. The file
  // count proves the scan reached the surface it governs.
  assert.ok(scannedFiles > 300, `scanned only ${scannedFiles} test files — the glob missed the surface`)
  const verdict = judgeQuarantine(markers, Date.now())
  assert.equal(verdict.ok, true, verdict.problems.join('\n'))
})
