// Run with: node --test .claude/workflows/lib/fix-loop.test.mjs
// dev-loop's fix loop decides whether a defect gets fixed or merely reported, so its selection
// logic is pinned here. The workflow sandbox has no module resolution, so dev-loop keeps a
// mirrored inline copy — the drift test at the bottom is what keeps the two honest.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { SEVERITY_RANK, triageReview } from './fix-loop.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workflowPath = path.join(__dirname, '..', 'dev-loop.workflow.mjs')

const finding = (severity, title) => ({ severity, title, file: 'a.ts', detail: 'd' })

test('confirmed findings at or above the threshold are actionable, below it are followups', () => {
  const review = { confirmedFindings: [finding('HIGH', 'h'), finding('LOW', 'l')], qa: [] }
  const { actionable, below } = triageReview(review, SEVERITY_RANK.MEDIUM)
  assert.deepEqual(actionable.map((f) => f.title), ['h'])
  assert.deepEqual(below.map((f) => f.title), ['l'])
})

// The defect this function exists to fix: a qa-scenario that FAILED with a reproduced bug used to
// be counted in the summary and then dropped on the floor, because the loop filtered
// confirmedFindings only. A reproduced defect is the strongest signal the gate produces.
test('a failed QA scenario becomes actionable rather than being dropped', () => {
  const review = {
    confirmedFindings: [],
    qa: [
      { scenario: 'smoke', status: 'pass', notes: 'fine' },
      { scenario: 'error-recovery', status: 'fail', notes: 'repeated create sends the same slug' },
    ],
  }
  const { actionable } = triageReview(review, SEVERITY_RANK.LOW)
  assert.equal(actionable.length, 1)
  assert.match(actionable[0].title, /error-recovery/)
  assert.equal(actionable[0].severity, 'HIGH')
  assert.match(actionable[0].detail, /same slug/)
})

test('passing and skipped QA scenarios are not actionable', () => {
  const review = {
    confirmedFindings: [],
    qa: [
      { scenario: 'smoke', status: 'pass' },
      { scenario: 'startup', status: 'skip' },
    ],
  }
  assert.deepEqual(triageReview(review, SEVERITY_RANK.LOW).actionable, [])
})

test('a missing or malformed review yields nothing actionable instead of throwing', () => {
  for (const bad of [null, undefined, {}, { confirmedFindings: 'nope', qa: 'nope' }]) {
    const { actionable, below } = triageReview(bad, SEVERITY_RANK.LOW)
    assert.deepEqual(actionable, [])
    assert.deepEqual(below, [])
  }
})

test('inline triageReview in dev-loop.workflow.mjs matches this module', () => {
  const source = readFileSync(workflowPath, 'utf8')
  const match = source.match(/\nconst SEVERITY_RANK = [\s\S]*?\nfunction triageReview\(review, threshold\) \{[\s\S]*?\n\}\n/)
  assert.ok(match, 'could not locate the inline SEVERITY_RANK + triageReview in dev-loop.workflow.mjs')
  // eslint-disable-next-line no-new-func -- evaluating our own source, not untrusted input
  const inline = new Function(`${match[0]}\nreturn { SEVERITY_RANK, triageReview }`)()
  assert.deepEqual(inline.SEVERITY_RANK, SEVERITY_RANK)
  const review = {
    confirmedFindings: [finding('HIGH', 'h'), finding('LOW', 'l')],
    qa: [{ scenario: 'error-recovery', status: 'fail', notes: 'boom' }],
  }
  assert.deepEqual(inline.triageReview(review, SEVERITY_RANK.MEDIUM), triageReview(review, SEVERITY_RANK.MEDIUM))
})

// `${BASE}..HEAD` re-anchors on every fetch, so a long run whose origin/main advanced reviewed a
// diff containing spurious reversions of unrelated commits. Three dots pins the range to the
// merge-base — the branch's own work — which is what review.workflow.mjs's own default already used.
test('dev-loop reviews a merge-base range, not a moving two-dot range', () => {
  const source = readFileSync(workflowPath, 'utf8')
  assert.match(source, /const reviewRange = `\$\{BASE\}\.\.\.HEAD`/)
  assert.doesNotMatch(source, /const reviewRange = `\$\{BASE\}\.\.HEAD`/)
})
