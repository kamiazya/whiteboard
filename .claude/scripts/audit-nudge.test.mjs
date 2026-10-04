// The audit cadence ("run audit-triage after each substantial fold, weekly,
// or pre-milestone" — dev-flow.md) was prose only: nothing reached a session
// that had not read the calendar. This nudge is the same shape as
// stale-issues/flake-watch — a quiet SessionStart hook — so the staleness is
// DISCOVERED at session start rather than remembered.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countUnrecordedWaves, formatNudge, parseAuditLog } from './lib/audit-log.mjs'

const NOW = Date.parse('2026-09-05T00:00:00Z')
const DAY = 86_400_000

test('parses jsonl entries and ignores blank lines', () => {
  const log = '{"kind":"audit-triage","at":"2026-08-30T10:00:00Z"}\n\n{"kind":"dogfood-triage","at":"2026-09-01T10:00:00Z"}\n'
  assert.deepEqual(parseAuditLog(log), [
    { kind: 'audit-triage', at: '2026-08-30T10:00:00Z' },
    { kind: 'dogfood-triage', at: '2026-09-01T10:00:00Z' },
  ])
})

test('a recent audit is silent', () => {
  const entries = [{ kind: 'audit-triage', at: new Date(NOW - 2 * DAY).toISOString() }]
  assert.equal(formatNudge(entries, NOW), '')
})

test('a stale audit names the age and the action', () => {
  const entries = [{ kind: 'audit-triage', at: new Date(NOW - 9 * DAY).toISOString() }]
  const out = formatNudge(entries, NOW)
  assert.match(out, /9 days/)
  assert.match(out, /audit-triage/)
})

test('no audit on record says so explicitly, not as age 0', () => {
  const out = formatNudge([], NOW)
  assert.match(out, /no audit-triage run on record/)
})

test('only audit-triage entries count toward the audit age', () => {
  const entries = [
    { kind: 'audit-triage', at: new Date(NOW - 10 * DAY).toISOString() },
    { kind: 'dogfood-triage', at: new Date(NOW - 1 * DAY).toISOString() },
  ]
  assert.match(formatNudge(entries, NOW), /10 days/)
})

test('audit-wave commits that never reached the ledger are named even when the last audit is fresh', () => {
  const entries = [{ kind: 'audit-triage', at: new Date(NOW - 1 * DAY).toISOString() }]
  const out = formatNudge(entries, NOW, 3)
  assert.match(out, /3 audit-wave commits/)
  assert.match(out, /record-audit\.mjs audit-triage/)
})

test('one unrecorded wave is singular, and none stays silent', () => {
  const entries = [{ kind: 'audit-triage', at: new Date(NOW - 1 * DAY).toISOString() }]
  assert.match(formatNudge(entries, NOW, 1), /1 audit-wave commit /)
  assert.equal(formatNudge(entries, NOW, 0), '')
})

test('a stale audit and unrecorded waves are both reported', () => {
  const entries = [{ kind: 'audit-triage', at: new Date(NOW - 9 * DAY).toISOString() }]
  const out = formatNudge(entries, NOW, 2)
  assert.match(out, /9 days/)
  assert.match(out, /2 audit-wave commits/)
})

test('a wave commit that itself touched the ledger counts as recorded', () => {
  const answers = new Map([
    ['--grep=audit wave', 'aaa\nbbb\nccc\n'],
    ['--', 'bbb\n'],
  ])
  const git = (args) => (args.includes('--') ? answers.get('--') : answers.get('--grep=audit wave'))
  assert.equal(countUnrecordedWaves('2026-09-01T00:00:00Z', git), 2)
})

test('no wave commits since the last audit counts zero', () => {
  assert.equal(countUnrecordedWaves('2026-09-01T00:00:00Z', () => ''), 0)
})
